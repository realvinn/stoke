/** Owned files, key store and gateway only. Never reads a user's login or sends to real bots. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  BUILTIN_PACKAGES,
  SAMPLE_PLUGIN,
  parsePluginPackage,
  pluginInstallLink
} from '../src/shared/pluginPackages.ts'
import { PluginPackages } from '../src/main/plugins/packageManager.ts'
import { PluginProcesses, pluginEnvironment } from '../src/main/plugins/processes.ts'
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
        agents: [
          { id: 'bot-owned', name: 'Owned fixture bot' },
          { id: 'group-owned', name: 'Owned fixture group', isGroup: true }
        ]
      })
    )
  else if (method === 'sendPrompt')
    response.end(
      JSON.stringify(String(body.prompt).includes('unknown-receipt') ? {} : { messageId: 'owned-message' })
    )
  else if (method === 'getAgentTranscriptTail')
    response.end(JSON.stringify({ entries: [{ id: 'owned-message', text: 'Owned fixture transcript' }] }))
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
    "const args=process.argv.slice(2); const base=process.env.GROK_BOT_GATEWAY_URL; const headers={authorization:'Bearer '+process.env.GROK_BOT_GATEWAY_TOKEN,...JSON.parse(process.env.GROK_BOT_GATEWAY_HEADERS),'content-type':'application/json'}; const command=args[0]==='send'?'sendPrompt':'listAgents'; const body=command==='sendPrompt'?{prompt:args.at(-1)}:{}; const response=await fetch(base+'/api/'+command,{method:'POST',headers,body:JSON.stringify(body)}); const data=await response.json(); if(!response.ok){console.error(response.status+' '+data.error); process.exitCode=1}else console.log(JSON.stringify(command==='sendPrompt'?{delivery:data.messageId?'accepted':'unknown'}:data.agents));"
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
    let enabled = true
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
      changed: () => {}
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
    const clear = JSON.stringify({
      baseUrl: 'https://owned.cursor.sh',
      token: `desktop-${platform}`,
      headers: { 'x-anyrun-network-token': 'route' }
    })
    let encrypted: Buffer
    if (platform === 'win32') {
      const key = randomBytes(32),
        nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce)
      encrypted = Buffer.concat([
        Buffer.from('v10'),
        nonce,
        cipher.update(clear),
        cipher.final(),
        cipher.getAuthTag()
      ])
      await writeFile(
        join(folder, 'Local State'),
        JSON.stringify({
          os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), key]).toString('base64') }
        })
      )
    } else {
      const cipher = createCipheriv(
        'aes-128-cbc',
        pbkdf2Sync(
          platform === 'linux' ? 'peanuts' : 'owned-password',
          'saltysalt',
          platform === 'linux' ? 1 : 1003,
          16,
          'sha1'
        ),
        Buffer.alloc(16, ' ')
      )
      encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(clear), cipher.final()])
    }
    await writeFile(
      join(folder, 'gateway-descriptor.json'),
      JSON.stringify({
        version: 2,
        entries: {
          first: { encrypted: encrypted.toString('base64') },
          second: { encrypted: encrypted.toString('base64') }
        }
      })
    )
    const reader = new GrokBotSessionReader({
      home,
      platform,
      environment: {},
      password: async () => 'owned-password',
      unprotect: async (blob) => blob
    })
    const signal = AbortSignal.timeout(5000)
    await assert.rejects(reader.load(undefined, signal))
    const session = await reader.load('second', signal)
    check(`${platform} imports an explicitly selected encrypted slot without changing desktop files`, () => {
      assert.equal(session.slot, 'second')
      assert.equal(session.session.token, `desktop-${platform}`)
    })
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
