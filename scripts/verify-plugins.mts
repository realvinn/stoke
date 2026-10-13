/** Owned files, key store and gateway only. Never reads a user's login or sends to real bots. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  BUILTIN_PACKAGES,
  SAMPLE_PLUGIN,
  parsePluginPackage,
  pluginInstallLink
} from '../src/shared/pluginPackages.ts'
import { PluginPackages } from '../src/main/plugins/packageManager.ts'
import { PluginBusyError, PluginProcesses, pluginEnvironment } from '../src/main/plugins/processes.ts'
import { GrokBotRuntime } from '../src/main/plugins/grokBotRuntime.ts'
import { GrokBotSessionReader } from '../src/main/plugins/grokBotSession.ts'
import { GrokBotPlugin } from '../src/main/plugins/grokBot.ts'
import { marketplaceResponse } from '../worker/marketplace.ts'
import { grokBotGateway } from '../src/shared/grokBot.ts'
import { sshDirectIp, linkedSshRoutes, applySshMerge } from '../src/shared/sshRoutes.ts'
import { sshMergeGroups, prepareSshRoute } from '../src/main/sshRoutes.ts'
import { buildSshArgs, buildUploadArgs, sshExecutable, sshChildEnv } from '../src/main/ssh.ts'
import type { SecretBackend } from '../src/main/secrets.ts'
let count = 0
const check = (name: string, fn: () => unknown): void => {
  fn()
  count++
  console.log(`  PASS ${name}`)
}
const root = await mkdtemp(join(tmpdir(), 'stoke-plugins-verify-'))
const backendKey = randomBytes(32)
const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  selectedBackend: () => null,
  encrypt: (plain) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', backendKey, iv)
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  },
  decrypt: (sealed) => {
    const cipher = createDecipheriv('aes-256-gcm', backendKey, sealed.subarray(0, 12))
    cipher.setAuthTag(sealed.subarray(-16))
    return Buffer.concat([cipher.update(sealed.subarray(12, -16)), cipher.final()]).toString()
  }
}
let workEnabled = true
const packages = new PluginPackages({
  root: join(root, 'plugins'),
  executable: process.execPath,
  environment: { PATH: process.env.PATH, HOME: root },
  workEnabled: async () => workEnabled,
  builtinToggle: async (id, value) => {
    if (id === 'work') workEnabled = value
  },
  changed: () => {}
})
let grok: GrokBotPlugin | null = null
const requests: { authorization: string; route: string; method: string; body: Record<string, unknown> }[] = []
const featureAgents = [{ id: 'bot-owned', name: 'Owned fixture bot', isGroup: false, memberIds: [] as string[], description: '' }, { id: 'group-owned', name: 'Owned fixture group', isGroup: true, memberIds: ['bot-owned'], description: '' }]
let featureSkills = [{ id: 'skill-owned', name: 'Owned skill', description: 'Owned library', source: 'workflow' }]
let featureApprovalPending = true
const server = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk
  const method = request.url!.split('/').at(-1)!,
    body = JSON.parse(text || '{}')
  const authorization = String(request.headers.authorization),
    route = String(request.headers['x-test-route'])
  requests.push({ authorization, route, method, body })
  response.setHeader('content-type', 'application/json')
  if (authorization === 'Bearer expired-token') {
    response.statusCode = 401
    response.end(JSON.stringify({ error: 'Expired login' }))
    return
  }
  if (method === 'listAgents')
    response.end(
      JSON.stringify({
        agents: featureAgents
      })
    )
  else if (method === 'sendPrompt')
    response.end(
      JSON.stringify(
        String(body.prompt).includes('unknown-receipt') ? {}
          : String(body.prompt).includes('boolean-receipt') ? { accepted: true }
            : String(body.prompt).includes('false-receipt') ? { accepted: false }
              : String(body.prompt).includes('string-receipt') ? { accepted: 'true' }
                : { messageId: 'owned-message' }
      )
    )
  else if (method === 'getAgentTranscriptTail')
    response.end(JSON.stringify({ entries: [{ id: 'owned-message', text: 'Owned fixture transcript' }, ...(featureApprovalPending ? [{ id: 'approval-entry', kind: 'send-message', message: { type: 'auto-review-approval', approval: { requestId: 'approval-request', status: 'pending', command: 'echo owned approval', summary: 'Owned test action' } } }] : [])] }))
  else if (['createAgent', 'createGroup'].includes(method)) {
    const agent = { id: 'created-' + featureAgents.length, name: String(body.name), description: String(body.description || ''), isGroup: method === 'createGroup', memberIds: (body.memberAgentIds || []) as string[] }
    featureAgents.push(agent); response.end(JSON.stringify({ agent }))
  } else if (method === 'updateAgent') {
    Object.assign(featureAgents.find(agent => agent.id === body.id)!, body.profile); response.end('{}')
  } else if (method === 'setAgentNotifyOnUpdates' || method === 'setAgentHiddenFromSidebar') {
    Object.assign(featureAgents.find(agent => agent.id === body.id)!, method === 'setAgentNotifyOnUpdates' ? { notifyOnUpdatesEnabled: body.isEnabled } : { isHiddenFromSidebar: body.isHidden }); response.end('{}')
  } else if (method === 'setGroupMembers') {
    const agent = featureAgents.find(agent => agent.id === body.id)!
    agent.memberIds = body.memberAgentIds as string[]; response.end(JSON.stringify({ agent }))
  } else if (method === 'deleteAgent') {
    featureAgents.splice(featureAgents.findIndex(agent => agent.id === body.id), 1); response.end('{}')
  } else if (method === 'getAgentWorkflows') response.end(JSON.stringify({ workflows: featureSkills }))
  else if (method === 'importAgentWorkflowText') {
    const skill = { id: 'imported-owned', name: 'Imported skill', description: 'Owned text', source: 'workflow' }
    featureSkills.push(skill); response.end(JSON.stringify({ workflows: featureSkills, result: { imported: [skill] } }))
  } else if (method === 'deleteAgentWorkflow') { featureSkills = featureSkills.filter(skill => skill.id !== body.workflowId); response.end('{}') }
  else if (method === 'resolveAutoReviewApproval') { featureApprovalPending = false; response.end('{}') }
  else {
    response.statusCode = 404
    response.end('{}')
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number },
  gatewayUrl = `http://127.0.0.1:${address.port}`
try {
  check('package rejects traversal and Windows reserved filenames', () => {
    for (const path of ['../bad.mjs', '/bad.mjs', 'CON.mjs', 'folder/NUL.txt'])
      assert.throws(() => parsePluginPackage({ ...SAMPLE_PLUGIN, files: { [path]: '' } }))
  })
  check('package rejects case aliases, unsupported API and undeclared scripts', () => {
    assert.throws(() => parsePluginPackage({ ...SAMPLE_PLUGIN, files: { 'main.mjs': '', 'MAIN.mjs': '' } }))
    assert.throws(() => parsePluginPackage({ ...SAMPLE_PLUGIN, apiVersion: 2 }))
    assert.throws(() => parsePluginPackage({ ...SAMPLE_PLUGIN, permissions: [] }))
  })
  check('built-ins cannot be replaced with downloaded code', () => {
    assert.throws(() => parsePluginPackage(BUILTIN_PACKAGES[1]))
    assert.deepEqual(
      parsePluginPackage({ ...BUILTIN_PACKAGES[1], files: { 'evil.mjs': 'bad' } }, true),
      BUILTIN_PACKAGES[1]
    )
  })
  check('appearance only accepts readable supported values', () => {
    assert.throws(() =>
      parsePluginPackage({
        ...SAMPLE_PLUGIN,
        permissions: ['local-code', 'appearance'],
        appearance: { '--fs-sm': '0px' }
      })
    )
    assert.throws(() => parsePluginPackage({ ...SAMPLE_PLUGIN, appearance: { background: 'url(evil)' } }))
  })
  check('native install links only name compiled catalog entries', () => {
    assert.equal(pluginInstallLink('stoke://plugins/install?id=grok-bot'), 'grok-bot')
    assert.equal(pluginInstallLink('stoke://plugins/install?id=unknown'), null)
    assert.equal(pluginInstallLink('https://plugins/install?id=grok-bot'), null)
  })
  const initial = await packages.read()
  check('migration preserves Work and Grok Bot starts absent/off', () => {
    assert.equal(initial.entries[0].enabled, true)
    assert.equal(initial.entries[1].installed, false)
  })
  check('uninstalled catalog extensions are available for native review', () => assert.equal(initial.entries.find(entry => entry.manifest.id === SAMPLE_PLUGIN.id)?.installed, false))
  await packages.install(SAMPLE_PLUGIN)
  await assert.rejects(packages.run(SAMPLE_PLUGIN.id, 'read', root))
  check('installed code is disabled by default', () =>
    assert.equal(initial.entries.find((entry) => entry.manifest.id === 'grok-bot')?.enabled, false)
  )
  await packages.setEnabled(SAMPLE_PLUGIN.id, true)
  const summary = await packages.run(SAMPLE_PLUGIN.id, 'read', root)
  check('native action receives chosen project and returns genuine result', () => {
    assert.equal(summary.ok, true)
    assert.equal(JSON.parse(summary.output).project, root)
  })
  await packages.install({
    ...SAMPLE_PLUGIN,
    panel: { ...SAMPLE_PLUGIN.panel, actions: [{ id: 'read', label: 'Read', entry: 'main.mjs', args: [] }] },
    files: { 'main.mjs': "console.log('updated source')" }
  })
  await packages.setEnabled(SAMPLE_PLUGIN.id, true)
  check('same-version edited imports replace the complete package', () => assert.equal(summary.ok, true))
  const edited = await packages.run(SAMPLE_PLUGIN.id, 'read', null)
  check('updated asset runs from its new content folder', () => assert.match(edited.output, /updated source/))
  const slow = { ...SAMPLE_PLUGIN, id: 'slow-fixture', files: { 'main.mjs': 'setInterval(()=>{},1000)' } }
  await packages.install(slow)
  await packages.setEnabled(slow.id, true)
  const run = packages.run(slow.id, 'read', null)
  const stopped = assert.rejects(run)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await packages.setEnabled(slow.id, false)
  await stopped
  check('disabling cancels a live owned process', () => assert.ok(true))
  const processes = new PluginProcesses()
  let release!: (value: any) => void
  const prepared = processes.run(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const preparationStopped = assert.rejects(prepared)
  processes.stop()
  await preparationStopped
  release({
    executable: process.execPath,
    args: ['-e', "require('fs').writeFileSync(process.argv[1],'late')", join(root, 'late')],
    cwd: root,
    env: pluginEnvironment(process.env),
    input: ''
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await assert.rejects(readFile(join(root, 'late')))
  check('disabling cancels pending preparation before it can spawn', () => assert.ok(true))
  const capacity = new PluginProcesses()
  const pendingJobs = Array.from({ length: 4 }, () => capacity.run(() => new Promise(() => {})))
  const pendingDone = Promise.allSettled(pendingJobs)
  await assert.rejects(capacity.run(async () => { throw new Error('The fifth operation must never prepare') }), PluginBusyError)
  capacity.stop()
  await pendingDone
  check('capacity refusal is typed so only a read can choose to wait before trying again', () => assert.ok(true))
  await packages.remove(SAMPLE_PLUGIN.id)
  check('removal hides an extension and revokes execution', () => assert.ok(true))
  await assert.rejects(packages.run(SAMPLE_PLUGIN.id, 'read', root))
  check('child environment removes tokens, Node injection and duplicate PATH casing', () => {
    const env = pluginEnvironment({
      PATH: 'one',
      Path: 'two',
      NODE_OPTIONS: '--require evil',
      CURSOR_ACCESS_TOKEN: 'wrong',
      GROK_BOT_GATEWAY_TOKEN: 'wrong',
      HOME: root
    })
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.CURSOR_ACCESS_TOKEN, undefined)
    assert.equal(env.GROK_BOT_GATEWAY_TOKEN, undefined)
    assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === 'path').length, 1)
  })
  check('gateway credentials cannot be sent to arbitrary sites', () => {
    assert.throws(() => grokBotGateway('https://evil.example'))
    assert.throws(() => grokBotGateway(gatewayUrl))
    assert.equal(grokBotGateway(gatewayUrl, true), gatewayUrl)
  })
  // The default mandatory suite does not depend on registry/network availability.
  // Native probe installs and executes the actual pinned CLI separately.
  const fixtureCli = join(root, 'fixture-cli.mjs')
  await writeFile(
    fixtureCli,
    "const args=process.argv.slice(2); const base=process.env.GROK_BOT_GATEWAY_URL; const headers={authorization:'Bearer '+process.env.GROK_BOT_GATEWAY_TOKEN,...JSON.parse(process.env.GROK_BOT_GATEWAY_HEADERS),'content-type':'application/json'}; const command=args[0]==='send'?'sendPrompt':'listAgents'; const body=command==='sendPrompt'?{prompt:args.at(-1)}:{}; const response=await fetch(base+'/api/'+command,{method:'POST',headers,body:JSON.stringify(body)}); const data=await response.json(); if(!response.ok){console.error(response.status+' '+data.error); process.exitCode=1}else console.log(JSON.stringify(command==='sendPrompt'?{delivery:data.messageId?'accepted':'unknown',result:data,exitCode:0}:data.agents));"
  )
  // Injectable runtime method only on this owned instance; production is hash-pinned.
  const runtimeReady = GrokBotRuntime.prototype.ready,
    runtimeInstalled = GrokBotRuntime.prototype.installed
  const realArchive = process.env.STOKE_TEST_GBOT_TARBALL
  if (realArchive) {
    const archive = await readFile(realArchive),
      fetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://registry.npmjs.org/grok-bot-cli/-/grok-bot-cli-0.12.4.tgz')
      assert.equal(init?.redirect, 'error')
      return new Response(archive)
    }
    try {
      await new GrokBotRuntime(join(root, 'gbot')).install()
    } finally {
      globalThis.fetch = fetch
    }
  } else {
    GrokBotRuntime.prototype.ready = async () => fixtureCli
    GrokBotRuntime.prototype.installed = async () => true
  }
  try {
    let enabled = true, failStatus = false, desktopOpens = 0
    grok = new GrokBotPlugin({
      root: join(root, 'gbot'),
      executable: process.execPath,
      runner: fileURLToPath(new URL('../src/main/plugins/cliRunner.ts', import.meta.url)),
      platform: 'darwin',
      environment: {
        PATH: process.env.PATH,
        HOME: root,
        CURSOR_ACCESS_TOKEN: 'wrong',
        GROK_BOT_GATEWAY_TOKEN: 'wrong',
        GROK_BOT_GATEWAY_URL: 'https://evil.example'
      },
      backend,
      reader: new GrokBotSessionReader({ home: root, platform: 'darwin', environment: {} }),
      enabled: async () => enabled,
      openDesktop: async () => { desktopOpens++ },
      changed: () => { if (failStatus) throw new Error('Owned status update failed') }
    })
    for (let index = 1; index <= 5; index++)
      await grok.change({
        kind: 'manual',
        label: `Account ${index}`,
        gatewayUrl,
        token: `owned-token-${index}`,
        headers: { 'x-test-route': `owned-route-${index}` },
        allowLocal: true
      })
    let view = await grok.read()
    const beforeDesktop = requests.length
    const desktop = await grok.operate({ accountId: view.accounts[4].id, kind: 'desktop' })
    check('desktop handoff is explicit, does not run a gateway command and names the intended account', () => {
      assert.equal(desktop.ok, true); assert.equal(desktopOpens, 1); assert.equal(requests.length, beforeDesktop); assert.match(desktop.message!, /Account 5/)
    })
    check('five accounts retain distinct names and identities', () => {
      assert.equal(view.accounts.length, 5)
      assert.equal(new Set(view.accounts.map((account) => account.id)).size, 5)
      assert.ok(view.accounts.every((account) => account.status === 'saved'))
    })
    for (let index = 0; index < view.accounts.length; index++) {
      const result = await grok.operate({ accountId: view.accounts[index].id, kind: 'list' })
      assert.equal(result.ok, true, result.message)
      const seen = requests.slice(-2)
      assert.ok(
        seen.every(
          (request) =>
            request.authorization === `Bearer owned-token-${index + 1}` &&
            request.route === `owned-route-${index + 1}`
        )
      )
    }
    check('every operation uses the selected token and routing headers despite poisoned defaults', () =>
      assert.ok(requests.length >= 10)
    )
    const sent = await grok.operate({
      accountId: view.accounts[4].id,
      kind: 'send',
      target: 'bot-owned',
      message: '--files & % $ owned multiline\nmessage'
    })
    check('prompt is delivered as data with exact metacharacters and account 5', () => {
      assert.equal(sent.delivery, 'accepted')
      assert.equal(requests.at(-1)?.authorization, 'Bearer owned-token-5')
      assert.ok(String(requests.at(-1)?.body.prompt).includes('--files & % $ owned multiline\nmessage'))
    })
    const unknown = await grok.operate({
      accountId: view.accounts[0].id,
      kind: 'send',
      target: 'bot-owned',
      message: 'unknown-receipt'
    })
    check('unconfirmed delivery is never called successful or auto-retried', () => {
      assert.equal(unknown.ok, false)
      assert.equal(unknown.delivery, 'unknown')
    })
    const beforeBoolean = requests.filter(request => request.method === 'sendPrompt').length
    const accepted = await grok.operate({ accountId: view.accounts[4].id, kind: 'send', target: 'bot-owned', message: 'boolean-receipt' })
    check('current gateway accepted=true receipt succeeds without a messageId and sends exactly once', () => {
      assert.equal(accepted.ok, true, accepted.message)
      assert.equal(accepted.delivery, 'accepted')
      assert.equal((accepted.data as { delivery: string }).delivery, 'accepted')
      assert.equal(requests.filter(request => request.method === 'sendPrompt').length, beforeBoolean + 1)
      assert.equal(requests.at(-1)?.authorization, 'Bearer owned-token-5')
    })
    for (const message of ['false-receipt', 'string-receipt']) {
      const before = requests.filter(request => request.method === 'sendPrompt').length
      const receipt = await grok.operate({ accountId: view.accounts[0].id, kind: 'send', target: 'bot-owned', message })
      check(`${message} is not a confirmed receipt and never triggers an automatic retry`, () => {
        assert.equal(receipt.ok, false)
        assert.equal(receipt.delivery, 'unknown')
        assert.equal(requests.filter(request => request.method === 'sendPrompt').length, before + 1)
      })
    }
    failStatus = true
    try {
      const before = requests.filter(request => request.method === 'sendPrompt').length
      const receipt = await grok.operate({ accountId: view.accounts[4].id, kind: 'send', target: 'bot-owned', message: 'boolean-receipt with failed account status save' })
      check('account-status failure after server acceptance preserves success without resending', () => {
        assert.equal(receipt.ok, true, receipt.message)
        assert.equal(receipt.delivery, 'accepted')
        assert.equal(requests.filter(request => request.method === 'sendPrompt').length, before + 1)
      })
    } finally { failStatus = false }
    if (realArchive) {
      const accountId = view.accounts[4].id
      const run = async (operation: Omit<import('../src/shared/grokBot.ts').GrokBotOperation, 'accountId'>) => {
        const before = requests.length, result = await grok!.operate({ accountId, ...operation })
        assert.equal(result.ok, true, result.message)
        assert.ok(requests.slice(before).every(request => request.authorization === 'Bearer owned-token-5' && request.route === 'owned-route-5'))
        return result.data as Record<string, unknown>
      }
      const bot = await run({ kind: 'create', name: 'CLI-created bot', description: 'Owned description' })
      check('reviewed CLI creates a named bot through the selected account', () => assert.equal(bot.name, 'CLI-created bot'))
      const updated = await run({ kind: 'update', target: String(bot.id), name: 'Renamed bot', title: 'Owned title', description: 'Updated description', notify: true, hidden: true })
      check('reviewed CLI updates profiles, visibility and notification settings', () => { assert.equal(updated.name, 'Renamed bot'); assert.equal(updated.hiddenFromSidebar, true); assert.equal(updated.notifyOnAgentUpdates, true) })
      const group = await run({ kind: 'create', targetKind: 'group', name: 'CLI-created group', members: ['bot-owned', String(bot.id)] })
      await run({ kind: 'members-set', target: String(group.id), members: ['bot-owned'] })
      const members = await run({ kind: 'get', targetKind: 'group', target: String(group.id) })
      check('reviewed CLI creates groups and replaces their members using bot IDs', () => assert.deepEqual(members.members, ['bot-owned']))
      await run({ kind: 'thread', target: 'bot-owned', limit: 200 })
      check('expanded history asks the gateway for the requested bounded limit', () => assert.equal(requests.findLast(request => request.method === 'getAgentTranscriptTail')?.body.limit, 200))
      await run({ kind: 'skills' })
      const skill = await run({ kind: 'skill-add', markdown: '---\nname: owned\ndescription: owned\n---\n\nOwned instructions.' })
      check('shared skill import sends only the supplied Markdown through a temporary owned file', () => { assert.equal(skill.id, 'imported-owned'); assert.match(String(requests.findLast(request => request.method === 'importAgentWorkflowText')?.body.markdown), /Owned instructions/); })
      assert.deepEqual((await readdir(join(root, 'gbot', 'data', 'grok-bot'))).filter(file => file.startsWith('skill-')), [])
      await run({ kind: 'skill-remove', target: 'imported-owned' })
      check('reviewed CLI removes library skills by ID', () => assert.ok(!featureSkills.some(skill => skill.id === 'imported-owned')))
      const approvals = await run({ kind: 'approvals', target: 'bot-owned' })
      check('approval listing does not resolve a request', () => { assert.equal((approvals.approvals as unknown[]).length, 1); assert.equal(requests.filter(request => request.method === 'resolveAutoReviewApproval').length, 0) })
      await run({ kind: 'approval-respond', target: 'bot-owned', entryId: 'approval-entry', requestId: 'approval-request', decision: 'accept' })
      check('explicit approval rechecks the pending card and resolves it once', () => assert.equal(requests.findLast(request => request.method === 'resolveAutoReviewApproval')?.body.resolution, 'approved'))
      const beforeStale = requests.filter(request => request.method === 'resolveAutoReviewApproval').length
      const stale = await grok!.operate({ accountId, kind: 'approval-respond', target: 'bot-owned', entryId: 'approval-entry', requestId: 'approval-request', decision: 'accept' })
      check('a stale approval is refused without a second resolution', () => { assert.equal(stale.ok, false); assert.equal(requests.filter(request => request.method === 'resolveAutoReviewApproval').length, beforeStale) })
      await run({ kind: 'delete', targetKind: 'group', target: String(group.id) })
      await run({ kind: 'delete', target: String(bot.id) })
      check('reviewed CLI deletes only the selected bot and group', () => assert.deepEqual(featureAgents.map(agent => agent.id), ['bot-owned', 'group-owned']))
    }
    const persisted = await readFile(join(root, 'gbot', 'grok-bot-accounts.json'), 'utf8')
    check('credentials are sealed at rest and absent from public views', () => {
      for (let index = 1; index <= 5; index++) {
        assert.ok(!persisted.includes(`owned-token-${index}`))
        assert.ok(!JSON.stringify(view).includes(`owned-token-${index}`))
      }
    })
    await grok.change({ kind: 'rename', id: view.accounts[0].id, label: 'Personal' })
    await grok.change({ kind: 'default', id: view.accounts[4].id })
    view = await grok.read()
    check('rename/default preserve other accounts and verified status', () => {
      assert.equal(view.defaultAccount, view.accounts[4].id)
      assert.equal(view.accounts[0].label, 'Personal')
      assert.ok(view.accounts.every((account) => account.status === 'connected'))
    })
    enabled = false
    grok.stop()
    await assert.rejects(grok.operate({ kind: 'list', accountId: view.accounts[0].id }))
    check('disabled plugin rejects IPC-equivalent reads and commands', () => assert.ok(true))
    await assert.rejects(grok.read())
  } finally {
    GrokBotRuntime.prototype.ready = runtimeReady
    GrokBotRuntime.prototype.installed = runtimeInstalled
  }
  for (const platform of ['darwin', 'linux', 'win32']) {
    const home = join(root, platform),
      folder =
        platform === 'darwin'
          ? join(home, 'Library', 'Application Support', 'Grok Bot')
          : platform === 'linux'
            ? join(home, '.config', 'Grok Bot')
            : join(home, 'AppData', 'Roaming', 'Grok Bot')
    await mkdir(folder, { recursive: true })
    const key = platform === 'win32'
      ? randomBytes(32)
      : pbkdf2Sync(
          platform === 'linux' ? 'peanuts' : 'owned-password',
          'saltysalt',
          platform === 'linux' ? 1 : 1003,
          16,
          'sha1'
        )
    const seal = (slot: string, prefix = 'v10'): string => {
      const clear = JSON.stringify({
        baseUrl: 'https://owned.cursor.sh',
        token: `desktop-${platform}-${slot}`,
        headers: { 'x-anyrun-network-token': `route-${slot}` },
        // v3 keeps ancillary desktop routing data alongside the gateway tuple.
        vncProxy: { primaryUrl: 'https://owned.cursor.sh', forkBaseUrl: 'https://owned.cursor.sh', networkToken: 'owned-vnc-route' }
      })
      const nonce = platform === 'win32' ? randomBytes(12) : Buffer.alloc(16, ' ')
      const sessionKey = platform === 'linux' && prefix === 'v11'
        ? pbkdf2Sync('owned-password', 'saltysalt', 1, 16, 'sha1') : key
      const cipher = createCipheriv(platform === 'win32' ? 'aes-256-gcm' : 'aes-128-cbc', sessionKey, nonce)
      return Buffer.concat([
        Buffer.from(prefix),
        ...(platform === 'win32' ? [nonce] : []),
        cipher.update(clear), cipher.final(),
        ...(platform === 'win32' ? [(cipher as import('node:crypto').CipherGCM).getAuthTag()] : [])
      ]).toString('base64')
    }
    if (platform === 'win32') {
      await writeFile(
        join(folder, 'Local State'),
        JSON.stringify({
          os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), key]).toString('base64') }
        })
      )
    }
    const path = join(folder, 'gateway-descriptor.json')
    let keyReads = 0
    const reader = new GrokBotSessionReader({
      home,
      platform,
      environment: {},
      password: async () => { keyReads++; return 'owned-password' },
      unprotect: async (blob) => { keyReads++; return blob }
    })
    const signal = AbortSignal.timeout(5000)
    const localState = platform === 'win32' ? await readFile(join(folder, 'Local State')) : null
    await assert.rejects(reader.sources(signal), /No Grok Bot gateway session.*Computer view/)
    check(`${platform} missing session names the Computer connection step`, () => assert.equal(keyReads, 0))
    const marker = JSON.stringify({ version: 1, signedIn: true, pid: 123, appVersion: '0.70.2' })
    await writeFile(join(folder, 'desktop-status.json'), marker)
    await assert.rejects(reader.sources(signal), /reports a signed-in account.*Computer view/)
    await assert.rejects(reader.load(undefined, signal), /reports a signed-in account.*Computer view/)
    await assert.rejects(readFile(path))
    check(`${platform} signed-in marker explains missing gateway without reading credentials or creating a file`, () => assert.equal(keyReads, 0))
    const privateValue = ['owned', 'private', 'descriptor'].join('-')
    await writeFile(path, `{"encrypted":"${privateValue}",broken`)
    await assert.rejects(reader.sources(signal), error => error instanceof Error && /invalid JSON/.test(error.message) && !error.message.includes(privateValue))
    check(`${platform} invalid JSON is distinct from a missing login and does not echo its contents`, () => assert.equal(keyReads, 0))
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1, ' '))
    await assert.rejects(reader.sources(signal), /too large to import/)
    check(`${platform} oversized file keeps its useful diagnostic`, () => assert.equal(keyReads, 0))
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await writeFile(path, '{}')
      await chmod(path, 0o000)
      try {
        await assert.rejects(reader.sources(signal), /does not have permission.*same OS user/)
        check(`${platform} unreadable owned file reports permissions instead of sign-in`, () => assert.equal(keyReads, 0))
      } finally { await chmod(path, 0o600) }
    }
    await rm(path)
    await writeFile(join(folder, 'desktop-status.json'), '{invalid-status')
    await assert.rejects(reader.sources(signal), /No Grok Bot gateway session.*Computer view/)
    const aborted = new AbortController()
    aborted.abort(new Error('owned cancellation'))
    await assert.rejects(reader.sources(aborted.signal), /owned cancellation/)
    check(`${platform} malformed status marker does not mask missing-session guidance and cancellation stays cancellation`, () => assert.equal(keyReads, 0))
    await writeFile(join(folder, 'desktop-status.json'), marker)
    for (const version of [undefined, 1, 2, 3]) {
      const multi = version === 2 || version === 3
      const slot = multi ? 'second' : 'current'
      const before = JSON.stringify(multi ? { version, entries: {
        first: { savedAtMs: Date.now(), encrypted: seal('first') },
        second: { savedAtMs: Date.now(), encrypted: seal('second') }
      } } : { version, encrypted: seal(slot) })
      await writeFile(path, before)
      keyReads = 0
      const sources = await reader.sources(signal)
      check(`${platform} v${version ?? 'legacy'} lists only source metadata without opening credentials`, () => {
        assert.deepEqual(sources, multi ? [
          { id: 'first', label: 'Saved desktop session 1' },
          { id: 'second', label: 'Saved desktop session 2' }
        ] : [{ id: 'current', label: 'Current desktop login' }])
        assert.equal(keyReads, 0)
      })
      if (multi) await assert.rejects(reader.load(undefined, signal), /Choose which saved desktop session/)
      await assert.rejects(reader.load('missing', signal), /Choose which saved desktop session/)
      const session = await reader.load(multi ? slot : undefined, signal)
      check(`${platform} v${version ?? 'legacy'} imports the selected gateway tuple`, () => {
        assert.equal(session.slot, slot)
        assert.equal(session.session.token, `desktop-${platform}-${slot}`)
        assert.deepEqual(session.session.headers, { 'x-anyrun-network-token': `route-${slot}` })
        assert.equal(session.session.gatewayUrl, 'https://owned.cursor.sh')
        assert.equal('vncProxy' in session.session, false)
      })
      const after = await readFile(path, 'utf8')
      check(`${platform} v${version ?? 'legacy'} leaves desktop descriptor and protection key unchanged`, () => assert.equal(after, before))
      if (localState) assert.deepEqual(await readFile(join(folder, 'Local State')), localState)
    }
    if (platform === 'linux') {
      keyReads = 0
      await writeFile(path, JSON.stringify({ version: 3, entries: { keyring: { savedAtMs: Date.now(), encrypted: seal('keyring', 'v11') } } }))
      await reader.sources(signal)
      assert.equal(keyReads, 0)
      const keyring = await reader.load('keyring', signal)
      check('Linux v3 also supports v11 Secret Service protection', () => {
        assert.equal(keyReads, 1)
        assert.equal(keyring.session.token, 'desktop-linux-keyring')
      })
    }
    keyReads = 0
    await writeFile(path, JSON.stringify({ version: 3, entries: {
      expired: { savedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000, encrypted: seal('expired') },
      fresh: { savedAtMs: Date.now(), encrypted: seal('fresh') }
    } }))
    await assert.rejects(reader.load('expired', signal), /expired.*Open Grok Bot.*refresh/)
    assert.equal(keyReads, 0)
    const fresh = await reader.load('fresh', signal)
    check(`${platform} rejects expired v3 snapshots before decryption and still imports a fresh slot`, () => assert.equal(fresh.session.token, `desktop-${platform}-fresh`))
    if (localState) {
      await rm(join(folder, 'Local State'))
      try {
        await assert.rejects(reader.load('fresh', signal), /Windows encryption-key file is missing/)
        check('missing Windows protection key is distinct from a missing gateway session', () => assert.ok(true))
      } finally { await writeFile(join(folder, 'Local State'), localState) }
    }
    const imported = new GrokBotPlugin({
      root: join(root, `v3-import-${platform}`), executable: process.execPath,
      runner: fileURLToPath(new URL('../src/main/plugins/cliRunner.ts', import.meta.url)),
      platform, environment: {}, backend: { ...backend, selectedBackend: () => platform === 'linux' ? 'gnome_libsecret' : null },
      reader, enabled: async () => true, changed: () => {}
    })
    try {
      await imported.change({ kind: 'import', label: 'Owned v3 account', sourceSlot: 'fresh' })
      const view = await imported.read()
      assert.equal(view.accounts[0].sourceSlot, 'fresh')
      assert.equal(view.accounts[0].source, 'desktop')
      const persisted = await readFile(join(root, `v3-import-${platform}`, 'grok-bot-accounts.json'), 'utf8')
      assert.ok(!persisted.includes(`desktop-${platform}-fresh`))
      // A later desktop account switch must not change the imported snapshot.
      await writeFile(path, JSON.stringify({ version: 3, entries: { other: { savedAtMs: Date.now(), encrypted: seal('other') } } }))
      const saved = await imported.exportForSync()
      check(`${platform} v3 import stays sealed and keeps its selected identity after a desktop account switch`, () => {
        assert.equal(saved.length, 1)
        assert.equal(saved[0].credential.token, `desktop-${platform}-fresh`)
        assert.deepEqual(saved[0].credential.headers, { 'x-anyrun-network-token': 'route-fresh' })
      })
    } finally { imported.stop() }
    for (const raw of [
      { version: 4 }, { version: 'secret-looking-unsupported-value' },
      { version: 2, entries: [] }, { version: 3, entries: null },
      { version: 3, entries: {} },
      ...[undefined, 'today', -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(savedAtMs => ({ version: 3, entries: { first: { savedAtMs, encrypted: seal('first') } } })),
      { version: 3, entries: { '': { savedAtMs: Date.now(), encrypted: seal('first') } } },
      { version: 3, entries: { first: { savedAtMs: Date.now(), encrypted: 'invalid-base64!' } } }
    ]) {
      await writeFile(path, JSON.stringify(raw))
      await assert.rejects(reader.sources(signal), error => error instanceof Error && !error.message.includes('secret-looking-unsupported-value'))
    }
    check(`${platform} rejects future formats and malformed v3 entries without exposing file values`, () => assert.ok(true))

    // One normal desktop app can retain five native logins while exporting
    // connections for just two. The importer must show all five without
    // decrypting OAuth/profile values or treating missing gateways as logins.
    const nativePath = join(folder, 'sand-secrets.json')
    const oldDescriptor = await readFile(path)
    const ids = Array.from({ length: 5 }, (_, i) => createHash('sha256').update(`owned-native-${platform}-${i}`).digest('hex'))
    const nativeAccounts = Object.fromEntries(ids.map((id, i) => [id, {
      'cursor-access-token': ['owned', 'sealed', 'access', String(i)].join('-'),
      'cursor-refresh-token': ['owned', 'sealed', 'refresh', String(i)].join('-'),
      'cursor-account-profile': ['owned', 'private', 'profile', String(i)].join('-')
    }]))
    const nativeFile = (active: string): string => JSON.stringify({ version: 1, 'cursor-accounts': JSON.stringify({ active, accounts: nativeAccounts }) })
    const gatewayFile = (selected: string[]): string => JSON.stringify({ version: 3, entries: Object.fromEntries(selected.map(id => [id, { savedAtMs: Date.now(), encrypted: seal(id) }])) })
    const nativeImporter = new GrokBotPlugin({
      root: join(root, `native-five-logins-${platform}`), executable: process.execPath,
      runner: fileURLToPath(new URL('../src/main/plugins/cliRunner.ts', import.meta.url)),
      platform, environment: {}, backend: { ...backend, selectedBackend: () => platform === 'linux' ? 'gnome_libsecret' : null },
      reader, enabled: async () => true, changed: () => {}
    })
    const nativeSignal = AbortSignal.timeout(10000)
    try {
      await writeFile(nativePath, nativeFile(ids[2]))
      await writeFile(path, gatewayFile(ids.slice(0, 2)))
      keyReads = 0
      const listed = await reader.sources(nativeSignal)
      check(`${platform} one desktop app exposes five saved logins even with just two gateway exports`, () => {
        assert.equal(listed.length, 5)
        assert.deepEqual(listed.map(source => source.id), ids)
        assert.equal(listed.filter(source => source.connection === 'saved').length, 2)
        assert.equal(listed.filter(source => source.connection === 'missing').length, 3)
        assert.equal(listed.find(source => source.current)?.id, ids[2])
        assert.ok(listed.every(source => source.nativeLogin === true))
        assert.equal(keyReads, 0)
        assert.ok(!JSON.stringify(listed).includes('owned-sealed'))
        assert.ok(!JSON.stringify(listed).includes('owned-private'))
      })
      await assert.rejects(reader.load(ids[2], nativeSignal), /no saved computer connection.*Switch to this account.*Computer/)
      assert.equal(keyReads, 0)
      check(`${platform} an unconnected native login gives switcher instructions without using either cached account`, () => assert.ok(true))
      await writeFile(path, JSON.stringify({ version: 3, entries: { [ids[2]]: { savedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000, encrypted: seal(ids[2]) } } }))
      const expiredNative = await reader.sources(nativeSignal)
      check(`${platform} saved native login stays visible when its exported computer connection expires`, () => {
        assert.equal(expiredNative.length, 5)
        assert.equal(expiredNative.find(source => source.id === ids[2])?.connection, 'expired')
        assert.equal(keyReads, 0)
      })
      await rm(path)
      const unconnected = await reader.sources(nativeSignal)
      await assert.rejects(reader.load(ids[4], nativeSignal), /no saved computer connection.*Computer/)
      check(`${platform} native logins remain visible before any computer descriptor exists`, () => {
        assert.equal(unconnected.length, 5)
        assert.ok(unconnected.every(source => source.connection === 'missing'))
        assert.equal(keyReads, 0)
      })
      const beforeAccounts = nativeFile(ids[4]), beforeConnections = gatewayFile(ids)
      await writeFile(nativePath, beforeAccounts)
      await writeFile(path, beforeConnections)
      const ready = await reader.sources(nativeSignal)
      assert.ok(ready.every(source => source.connection === 'saved'))
      assert.equal(ready.find(source => source.current)?.id, ids[4])
      for (let i = 0; i < 5; i++) await nativeImporter.change({ kind: 'import', label: `Native account ${i + 1}`, sourceSlot: ids[i] })
      const savedNative = await nativeImporter.exportForSync()
      check(`${platform} all five logins from one app import as separate gateway snapshots after their computers connect`, () => {
        assert.equal(savedNative.length, 5)
        assert.deepEqual(savedNative.map(account => account.credential.token), ids.map(id => `desktop-${platform}-${id}`))
        assert.ok(!JSON.stringify(savedNative).includes('owned-sealed'))
      })
      assert.equal(await readFile(nativePath, 'utf8'), beforeAccounts)
      assert.equal(await readFile(path, 'utf8'), beforeConnections)
      await writeFile(nativePath, JSON.stringify({ version: 1, 'cursor-accounts': '{owned-private-broken-account-list' }))
      await assert.rejects(reader.sources(nativeSignal), error => error instanceof Error && /saved account list is unreadable/.test(error.message) && !error.message.includes('owned-private'))
      check(`${platform} native account discovery never modifies login storage or exposes malformed private contents`, () => assert.ok(true))
    } finally {
      nativeImporter.stop()
      await rm(nativePath, { force: true })
      await writeFile(path, oldDescriptor)
    }

    // Five app instances can each use --user-data-dir and the same slot name.
    // Windows must open each profile's own Local State key, never the default's.
    const profileStore = join(root, `desktop-profile-folders-${platform}.json`)
    const options = {
      home, platform, environment: {}, profileStore,
      password: async () => { keyReads++; return 'owned-password' },
      unprotect: async (blob: Buffer) => { keyReads++; return blob }
    }
    const multiple = new GrokBotSessionReader(options)
    const multiSignal = AbortSignal.timeout(15000)
    const profiles: { id: string; path: string; descriptor: string; protection: string | null }[] = []
    const defaultBefore = await readFile(path)
    const pickerPlugin = new GrokBotPlugin({
      root: join(root, `multi-profile-import-${platform}`), executable: process.execPath,
      runner: fileURLToPath(new URL('../src/main/plugins/cliRunner.ts', import.meta.url)),
      platform, environment: {}, backend: { ...backend, selectedBackend: () => platform === 'linux' ? 'gnome_libsecret' : null },
      reader: multiple, enabled: async () => true, changed: () => {}
    })
    try {
      assert.equal(await pickerPlugin.chooseProfile(async () => null), null)
      await assert.rejects(readFile(profileStore))
      for (let i = 0; i < 5; i++) {
        const profilePath = join(root, `Grok profile ${platform} ${i + 1} – O'Brien & test`)
        await mkdir(profilePath)
        const profileKey = platform === 'win32' ? randomBytes(32) : key
        const nonce = platform === 'win32' ? randomBytes(12) : Buffer.alloc(16, ' ')
        const cipher = createCipheriv(platform === 'win32' ? 'aes-256-gcm' : 'aes-128-cbc', profileKey, nonce)
        const encrypted = Buffer.concat([
          Buffer.from('v10'), ...(platform === 'win32' ? [nonce] : []),
          cipher.update(JSON.stringify({ baseUrl: 'https://owned.cursor.sh', token: `owned-profile-${platform}-${i}`, headers: { 'x-anyrun-network-token': `owned-route-${i}` } })),
          cipher.final(), ...(platform === 'win32' ? [(cipher as import('node:crypto').CipherGCM).getAuthTag()] : [])
        ]).toString('base64')
        const descriptor = JSON.stringify({ version: 3, entries: { current: { savedAtMs: Date.now(), encrypted } } })
        const protection = platform === 'win32'
          ? JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), profileKey]).toString('base64') } })
          : null
        await writeFile(join(profilePath, 'gateway-descriptor.json'), descriptor)
        if (protection) await writeFile(join(profilePath, 'Local State'), protection)
        keyReads = 0
        const picked = await pickerPlugin.chooseProfile(async () => profilePath)
        assert.ok(picked)
        assert.deepEqual(picked.sources, [{ id: 'current', label: 'Current desktop login' }])
        assert.equal(keyReads, 0)
        assert.equal('path' in picked, false)
        await pickerPlugin.change({ kind: 'import', profileId: picked.id, sourceSlot: 'current', label: `Account ${i + 1}` })
        profiles.push({ id: picked.id, path: profilePath, descriptor, protection })
      }
      const synced = await pickerPlugin.exportForSync()
      check(`${platform} imports all five separate desktop profiles with their own routing credentials and protection keys`, () => {
        assert.equal(synced.length, 5)
        assert.equal(new Set(profiles.map(profile => profile.id)).size, 5)
        assert.deepEqual(synced.map(account => account.credential.token), Array.from({ length: 5 }, (_, i) => `owned-profile-${platform}-${i}`))
        assert.deepEqual(synced.map(account => account.credential.headers), Array.from({ length: 5 }, (_, i) => ({ 'x-anyrun-network-token': `owned-route-${i}` })))
        assert.ok(!JSON.stringify(synced).includes('O\'Brien'))
      })
      assert.deepEqual(await readFile(path), defaultBefore)
      for (const profile of profiles) {
        assert.equal(await readFile(join(profile.path, 'gateway-descriptor.json'), 'utf8'), profile.descriptor)
        if (profile.protection) assert.equal(await readFile(join(profile.path, 'Local State'), 'utf8'), profile.protection)
      }
      check(`${platform} importing custom folders leaves every desktop session, default folder and protection key unchanged`, () => assert.ok(true))
      const restarted = new GrokBotSessionReader(options)
      keyReads = 0
      for (const profile of profiles) assert.equal((await restarted.sources(multiSignal, profile.id)).length, 1)
      const duplicate = await restarted.addProfile(join(profiles[0].path, '.'), multiSignal)
      assert.equal(duplicate.id, profiles[0].id)
      assert.equal(keyReads, 0)
      const remembered = JSON.parse(await readFile(profileStore, 'utf8'))
      check(`${platform} opaque folder selections survive a reader restart and duplicate selection stays one profile`, () => assert.equal(remembered.profiles.length, 5))
      const unknown = `gbprofile-${['00000000', '0000', '0000', '0000', '000000000000'].join('-')}`
      await assert.rejects(restarted.sources(multiSignal, unknown), /Choose a Grok Bot desktop profile folder again/)
      await assert.rejects(restarted.load('current', multiSignal, '../unselected-profile'), /Choose a Grok Bot desktop profile folder again/)
      await assert.rejects(restarted.addProfile(home, multiSignal), /No Grok Bot gateway session/)
      const cancelled = new AbortController()
      cancelled.abort(new Error('owned profile cancellation'))
      await assert.rejects(restarted.addProfile(profiles[0].path, cancelled.signal), /owned profile cancellation/)
      assert.equal(keyReads, 0)
      check(`${platform} invalid, unselected, missing and cancelled profile choices never fall back to the default login`, () => assert.ok(true))
      if (platform === 'win32') {
        const selectedKey = join(profiles[0].path, 'Local State')
        await rm(selectedKey)
        try {
          await assert.rejects(restarted.load('current', multiSignal, profiles[0].id), /Windows encryption-key file is missing/)
          assert.equal(keyReads, 0)
          check('a custom Windows profile with no key never uses another profile’s Local State', () => assert.ok(true))
        } finally { await writeFile(selectedKey, profiles[0].protection!) }
      }
    } finally { pickerPlugin.stop() }
  }
  for (const path of [
    '/marketplace',
    '/marketplace/sdk',
    '/marketplace/catalog.json',
    '/marketplace/plugins/grok-bot.stoke-plugin.json'
  ]) {
    const response = marketplaceResponse(new Request(`https://stoke.vinn.dev${path}`))!
    const body = await response.text()
    check(`marketplace serves ${path}`, () => {
      assert.equal(response.status, 200)
      assert.ok(body.length > 100)
    })
  }
  check('marketplace leaves installer namespace alone and handles missing packages', () => {
    assert.equal(marketplaceResponse(new Request('https://stoke.vinn.dev/install.sh')), null)
    assert.equal(
      marketplaceResponse(new Request('https://stoke.vinn.dev/marketplace/plugins/missing.json'))?.status,
      404
    )
  })
  check('SSH direct IP validation rejects option, user and port injection', () => {
    assert.equal(sshDirectIp('192.168.2.1'), '192.168.2.1')
    assert.equal(sshDirectIp('::1'), '::1')
    for (const text of ['-oProxyCommand=bad', 'user@1.2.3.4', '1.2.3.4:22', '999.1.1.1'])
      assert.equal(sshDirectIp(text), null)
  })
  const hosts = [
    { id: 'one', label: 'Box', alias: 'tailnet-box', command: '', remoteDeviceId: 'paired' },
    { id: 'two', label: 'Box IP', alias: '192.168.2.1', command: '', remoteDeviceId: 'paired' }
  ]
  check('Other machines sorts explicit linked direct IP routes first', () => {
    assert.equal(linkedSshRoutes(hosts, 'paired')[0].id, 'two')
    assert.equal(linkedSshRoutes(hosts, 'other').length, 0)
  })
  const group = {
    members: hosts.map((host) => ({ id: host.id, alias: host.alias, snapshot: JSON.stringify(host) })),
    preferredAddress: '192.168.2.1',
    reason: 'fixture'
  }
  check(
    'merging preserves first identity and alias, with direct preference and original alternatives',
    () => {
      const merged = applySshMerge(hosts, group)
      assert.equal(merged.length, 1)
      assert.equal(merged[0].id, 'one')
      assert.equal(merged[0].alias, 'tailnet-box')
      assert.equal(merged[0].preferredAddress, '192.168.2.1')
      assert.deepEqual(merged[0].mergedAliases, ['192.168.2.1'])
      assert.throws(() => applySshMerge([{ ...hosts[0], alias: 'changed' }, hosts[1]], group))
    }
  )
  check('a direct-IP-first merge still retains its verified tailnet fallback', () => { const reversed = [hosts[1], hosts[0]]; const merged = applySshMerge(reversed, { members: reversed.map(host => ({ id: host.id, alias: host.alias, snapshot: JSON.stringify(host) })), preferredAddress: '192.168.2.1', fallbackAlias: 'tailnet-box', reason: 'fixture' }); assert.equal(merged[0].id, 'two'); assert.equal(merged[0].alias, 'tailnet-box'); assert.deepEqual(merged[0].mergedAliases, ['192.168.2.1']) })
  check('interactive and transfer argv preserve alias identity and use direct IP options before it', () => {
    const host = { ...hosts[0], preferredAddress: '127.0.0.1' }
    assert.deepEqual(buildSshArgs(host).slice(0, 2), ['-o', 'Hostname=127.0.0.1'])
    assert.equal(buildSshArgs(host).at(-1), host.alias)
    assert.ok(buildUploadArgs(host, 'owned.txt', 1)?.includes('Hostname=127.0.0.1'))
  })
  check('without a preferred IP route selection is unchanged', () => assert.ok(true))
  assert.deepEqual(await prepareSshRoute(['-G', 'box'], sshExecutable(), sshChildEnv()), ['-G', 'box'])
  // Configuration/keygen fixtures are Node executables, never real ~/.ssh.
  const fakeSsh = join(root, 'fake-ssh' + (process.platform === 'win32' ? '.cmd' : ''))
  if (process.platform !== 'win32') {
    await writeFile(
      fakeSsh,
      `#!/bin/sh\ncase "$2" in\n wrong-user) user=other;; *) user=owned;; esac\nprintf 'host %s\\nhostname %s\\nuser %s\\nport 22\\nidentityfile owned-key\\n' "$2" "$2" "$user"\n`,
      { mode: 0o700 }
    )
    const fakeKeygen = join(root, 'fake-keygen')
    await writeFile(fakeKeygen, "#!/bin/sh\nprintf 'fixture ssh-ed25519 AAAAownedkey\\n'\n", { mode: 0o700 })
    const groups = await sshMergeGroups(
      [...hosts, { ...hosts[0], id: 'three', alias: 'wrong-user' }],
      fakeSsh,
      fakeKeygen,
      { PATH: process.env.PATH },
      AbortSignal.timeout(5000)
    )
    check('shared host keys merge matching identities and keep a different user separate', () => {
      assert.equal(groups.length, 1)
      assert.deepEqual(
        groups[0].members.map((member) => member.id),
        ['one', 'two']
      )
      assert.equal(groups[0].preferredAddress, '192.168.2.1')
    })
  }
} finally {
  grok?.stop()
  packages.stop()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
console.log(`${count} plugin, account, marketplace and SSH route checks passed`)
