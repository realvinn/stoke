import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from '@lydell/node-pty'
import { configSchema, readConfig, updateConfig } from '../src/terminal/config.ts'
import { AgentInput, ConsoleInput, composerView, nextCursor, previousCursor } from '../src/terminal/input.ts'
import stringWidth from 'string-width'
import { MENU_SECTIONS, menuItems, renderMenu } from '../src/terminal/menu.ts'
import { stripVTControlCharacters } from 'node:util'
import { history, launchArgs, Sessions } from '../src/terminal/sessions.ts'
import { createConnection } from 'node:net'
import { readServerInfo, processAlive } from '../src/terminal/sessionProtocol.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'stoke-terminal-'))
let checks = 0
function check(name: string, fn: () => void): void { fn(); checks++; console.log(`PASS ${name}`) }

try {
  check('Win32 input records open Stoke without losing native modifiers, Unicode or paste', () => {
    const packet = (uc: number, vk = 0, down = 1, control = 0, repeat = 1) => `\x1b[${vk};0;${uc};${down};${control};${repeat}_`
    const wrappedF5 = [...'\x1b[15~'].map(char => packet(char.charCodeAt(0))).join('')
    for (let split = 1; split < wrappedF5.length; split++) {
      const console = new ConsoleInput(), agent = new AgentInput()
      const first = agent.take(console.take(wrappedF5.slice(0, split), true))
      const last = agent.take(console.take(wrappedF5.slice(split), true))
      assert(first.menu || last.menu)
      assert.equal(first.forward + last.forward, '')
    }
    const console = new ConsoleInput(), agent = new AgentInput()
    assert.equal(agent.take(console.take(packet(0, 116), true)).menu, true, 'a physical F5 opens Stoke')
    assert.equal(console.take(packet(0, 116, 0), true), '', 'its key-up is consumed too')
    const modified = packet(0, 37, 1, 8)
    assert.equal(console.take(modified, true), modified, 'native agent key records retain their exact metadata')
    assert.equal(console.take(modified), '\x1b[1;5D', 'Stoke menus understand Ctrl+Left')
    assert.equal(console.take(packet(65, 65, 0)), '', 'menus ignore key-up events')
    assert.equal(console.take(packet(65, 65, 1, 0, 3)), 'AAA')
    assert.equal(console.take(packet(0xd83d) + packet(0xdc4b)), '👋')
    assert.equal(console.take('\x1b[0;0;'), '')
    assert.equal(console.flush(), '\x1b[0;0;')
    assert.equal(console.take('\x1b[1;5A'), '\x1b[1;5A', 'ordinary VT stays unchanged')
    const wrapped = (text: string) => [...text].map(char => packet(char.charCodeAt(0))).join('')
    const paste = agent.take(console.take(wrapped('\x1b[200~\x1b[15~\x1d\x1b[201~'), true))
    assert.equal(paste.detach, false, 'pasting shortcut text does not navigate')
    const literal = `\x1b[200~${packet(65)}\x1b[201~`
    assert.equal(new ConsoleInput().take(literal, true), literal, 'ordinary bracketed paste retains literal Win32-looking text')
  })
  const cfg = configSchema.parse({ agent: 'opencode', agents: { opencode: { models: ['provider/model'] } } })
  check('config validates defaults, agent IDs, models, URLs and SSH destinations', () => {
    assert.equal(cfg.agents.opencode.model, '')
    assert.equal(cfg.agent, 'opencode')
    for (const bad of [
      { agents: { typo: {} } }, { agent: 'typo' }, { agents: { opencode: { model: '--bad' } } },
      { remotes: { test: { kind: 'ssh', host: '-oProxyCommand=whoami' } } },
      { remotes: { test: { kind: 'opencode', url: 'file:///tmp/a' } } },
      { remotes: { test: { kind: 'opencode', url: 'https://user:secret@example.com' } } }
    ]) assert.equal(configSchema.safeParse(bad).success, false)
    assert.equal(readConfig(join(temp, 'absent.json')).agent, 'claude')
    writeFileSync(join(temp, 'bad.json'), '{ broken')
    assert.throws(() => readConfig(join(temp, 'bad.json')), /Invalid Stoke config/)
  })
  const manager = new Sessions(() => {}, () => {}, temp)
  check('multiline prompts render on one row without changing the submitted text', () => {
    const prompt = 'hello\nworld'; const view = composerView(prompt, prompt.length, '› ', 80)
    assert.equal(view.text, '› hello↵world')
    assert.equal(prompt, 'hello\nworld')
  })
  check('launch plans keep native interactive prompts, models and exact resume identity', () => {
    const chat = manager.create('opencode', temp, 'provider/model', 'hello world')
    assert.deepEqual(launchArgs(chat, cfg, 'hello world'), ['-m', 'provider/model', '--prompt', 'hello world'])
    assert.throws(() => launchArgs(chat, cfg, '', true), /No exact resume ID/)
    assert.deepEqual(launchArgs({ ...chat, nativeId: 'ses_abcdef' }, cfg, '', true), ['-m', 'provider/model', '--session', 'ses_abcdef'])
    const claude = manager.create('claude', temp, '')
    assert.deepEqual(launchArgs(claude, cfg), ['--session-id', claude.id])
    assert.deepEqual(launchArgs(claude, cfg, '', true), ['--resume', claude.id])
    delete claude.nativeId
    assert.throws(() => launchArgs(claude, cfg, '', true), /No exact resume ID/)
  })
  check('Ctrl+] escapes only agent focus and never a bracketed paste, across chunks', () => {
    const input = new AgentInput()
    assert.deepEqual(input.take('\x1b'), { forward: '', detach: false })
    assert.deepEqual(input.take('[200~hello\x1d'), { forward: '\x1b[200~hello\x1d', detach: false })
    assert.deepEqual(input.take('\x1b[201~'), { forward: '\x1b[201~', detach: false })
    assert.deepEqual(input.take('x\x1d/quit\r'), { forward: 'x', detach: true })
    assert.deepEqual(input.take('\x1b[D'), { forward: '\x1b[D', detach: false })
    assert.deepEqual(input.take('\x1b[1'), { forward: '', detach: false })
    assert.deepEqual(input.take('5~'), { forward: '', detach: true, menu: true })
    assert.deepEqual(input.take('\x1b[200~\x1b[15~\x1b[201~'), { forward: '\x1b[200~\x1b[15~\x1b[201~', detach: false })
    assert.deepEqual(input.take('\x1b'), { forward: '', detach: false })
    assert.equal(input.flush(), '\x1b')
    assert.equal(input.take('\x1b[15;1~').menu, true, 'unmodified CSI modifier notation opens the menu')
  })
  check('the menu searches titles and details and fits narrow terminals', () => {
    const view = { section: 'chats' as const, query: 'project alpha', selected: 0, notice: '', active: 'Claude', items: [
      { id: '1', title: 'Fix alpha', subtitle: 'Claude Code', detail: ['/project'] },
      { id: '2', title: 'Beta', subtitle: 'OpenCode', detail: ['/project'] }
    ] }
    assert.deepEqual(menuItems(view).map((item) => item.id), ['1'])
    for (const columns of [25, 80, 120]) {
      const lines = stripVTControlCharacters(renderMenu(view, columns, 24)).split('\r\n')
      assert.equal(lines.length, 24)
      for (const row of lines) assert.ok(stringWidth(row) < columns)
    }
    for (const section of MENU_SECTIONS) for (const theme of ['ember', 'ocean', 'terminal'] as const) {
      for (const columns of [25, 80, 120]) {
        const text = stripVTControlCharacters(renderMenu({ ...view, section, theme, form: {
          title: 'Add connection', description: 'Save an SSH host or an OpenCode server.', focused: 2, submit: 'Save connection', error: '', fields: [
            { key: 'name', label: 'Name', value: 'test' }, { key: 'kind', label: 'Type', value: 'ssh', choices: ['ssh', 'opencode'] }, { key: 'target', label: 'Target', value: 'long-host.example.com' }
          ] } }, columns, 24))
        const rows = text.split('\r\n')
        assert.equal(rows.length, 24)
        for (const row of rows) assert.ok(stringWidth(row) < columns)
      }
    }
  })
  check('settings edits merge fresh config data and reject invalid changes without overwriting the file', () => {
    const file = join(temp, 'merge-config.json')
    writeFileSync(file, JSON.stringify({ agent: 'opencode', agents: { opencode: { executable: '/custom/bin/opencode' } }, remotes: { work: { kind: 'ssh', host: 'work' } } }))
    updateConfig((latest) => { latest.ui.theme = 'ocean' }, file)
    updateConfig((latest) => { latest.agent = 'claude' }, file)
    const saved = readConfig(file)
    assert.equal(saved.ui.theme, 'ocean')
    assert.equal(saved.agents.opencode.executable, '/custom/bin/opencode')
    assert.equal(saved.remotes.work.kind, 'ssh')
    const before = readFileSync(file, 'utf8')
    assert.throws(() => updateConfig((latest) => { latest.remotes.bad = { kind: 'ssh', host: '-bad' } }, file))
    assert.equal(readFileSync(file, 'utf8'), before)
    writeFileSync(`${file}.lock`, 'locked')
    assert.throws(() => updateConfig((latest) => { latest.ui.theme = 'ember' }, file), /edit is in progress/)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
  check('cursor movement preserves emoji and combining characters', () => {
    const line = 'a👩‍💻éz'
    assert.equal(nextCursor(line, 1), 6)
    assert.equal(previousCursor(line, 6), 1)
    assert.equal(nextCursor(line, 6), 8)
    assert.equal(previousCursor(line, 8), 6)
    const long = '漢字👩‍💻é'.repeat(30)
    for (const columns of [20, 40, 80]) {
      const view = composerView(long, long.length, 'stoke · opencode › ', columns)
      assert.ok(stringWidth(view.text) < columns)
      assert.ok(stringWidth(view.beforeCursor) < columns)
      assert.ok(view.text.includes('‹'))
    }
  })
  const fixture = join(temp, process.platform === 'win32' ? 'fake-agent.cmd' : 'fake-agent')
  const fixtureCode = `#!/usr/bin/env node
process.stdin.setRawMode(true);
console.log('AGENT_READY:' + JSON.stringify({args:process.argv.slice(2),node:process.env.ELECTRON_RUN_AS_NODE || null}));
process.stdin.on('data', d => {
  console.log('AGENT_INPUT:' + JSON.stringify(d.toString()));
  if (d.toString().includes('EXIT_NOW')) process.exit(0);
});
process.stdout.on('resize', () => console.log('AGENT_SIZE:' + process.stdout.columns + 'x' + process.stdout.rows));
`
  if (process.platform === 'win32') {
    writeFileSync(join(temp, 'fake-agent.mjs'), fixtureCode)
    writeFileSync(fixture, '@echo off\r\nnode "%~dp0\\fake-agent.mjs" %*\r\n')
  } else writeFileSync(fixture, fixtureCode)
  chmodSync(fixture, 0o755)
  const file = join(temp, 'config.json')
  const config = { version: 1, agent: 'opencode', agents: {
    opencode: { executable: fixture }, claude: { executable: fixture }
  }, remotes: { lab: { kind: 'opencode', url: 'http://127.0.0.1:4096' } } }
  writeFileSync(file, JSON.stringify(config))
  const env = { ...process.env, STOKE_CONFIG: file, STOKE_TERMINAL_HOME: join(temp, 'state'), ELECTRON_RUN_AS_NODE: '1' }
  const terminal = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/terminal/index.ts'), temp],
    { cwd: root, cols: 120, rows: 36, env, name: 'xterm-256color' })
  let output = '', exited = false
  terminal.onData((data) => { output += data })
  terminal.onExit(() => { exited = true; if (process.platform === 'win32') try { terminal.kill() } catch { /* already released */ } })
  const until = async (predicate: () => boolean, description: string): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!predicate()) {
      if (Date.now() > deadline || exited) throw new Error(`${description}\n${output.slice(-5000)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const send = async (text: string, expected: string): Promise<string> => {
    const offset = output.length
    terminal.write(text)
    await until(() => stripVTControlCharacters(output.slice(offset)).includes(expected), `Waiting for ${expected}`)
    return output.slice(offset)
  }
  try {
    await until(() => output.includes('stoke · opencode'), 'Terminal composer')
    for (const [command, title] of [['/agent', 'Search agents:'], ['/models', 'Search models:'], ['/remote', 'Search connections:']]) {
      await send(command + '\r', title)
      await send('\x1b', 'stoke · opencode')
    }
    check('bare slash commands open searchable agent, model and connection pickers', () => {})
    await send('hello from Stoke\r', 'AGENT_READY:')
    check('text opens the native interactive agent with the prompt and strips Electron mode', () => {
      assert.match(output, /"args":\["--prompt","hello from Stoke"\]/)
      assert.match(output, /"node":null/)
      assert.doesNotMatch(output, /AGENT_INPUT:/) // The Enter which launched it is not relayed.
    })
    const menuOutput = await send('\x1b[15~', 'Search chats:')
    await send('hello', 'Search chats: hello')
    await send('\x12', 'Search connections:')
    await send('\x1b[15~', 'AGENT_READY:')
    check('F5 opens searchable Stoke navigation without forwarding the shortcut or ending the agent', () => {
      assert.doesNotMatch(menuOutput, /AGENT_INPUT:/)
      assert.equal(history(join(temp, 'state')).length, 1)
    })
    await send('/models\r', 'AGENT_INPUT:')
    check('agent slash commands reach the agent verbatim', () => assert.match(output, /AGENT_INPUT:"\/models\\r"/))
    await send('\x1d', 'Returned to Stoke')
    await send('\x1b[D', 'hello from Stoke')
    await send('\x1b', 'stoke · opencode')
    await send('/agent claude\r', 'Selected Claude Code')
    await send('/models sonnet\r', 'Model for the next chat: sonnet')
    await send('/new\r', 'AGENT_READY:')
    check('agent switching starts a separate chat with the selected model', () => {
      assert.match(output, /"args":\["--model","sonnet","--session-id","[a-f0-9-]+"\]/)
      assert.equal(history(join(temp, 'state')).length, 2)
    })
    terminal.resize(100, 30)
    await until(() => output.includes('AGENT_SIZE:100x30'), 'Native terminal resize')
    await send('\x1d', 'Returned to Stoke')
    await send('/chats\r', 'Use /attach NUMBER')
    const chats = history(join(temp, 'state'))
    const first = chats.findIndex((c) => c.agent === 'opencode') + 1
    await send(`/attach ${first}\r`, 'AGENT_READY:')
    const input = await send('still here\r', 'AGENT_INPUT:')
    check('older live chats reattach with their screen and accept input', () => assert.match(input, /still here/))
    await send('\x1b[15~', 'Search chats:')
    await send('\x07', 'Search agents:')
    await send('Claude Code', 'Search agents: Claude Code')
    await send('\r', 'AGENT_READY:')
    check('the agent picker starts a new agent without closing previous chats', () => assert.equal(history(join(temp, 'state')).length, 3))
    await send('\x1d', 'Returned to Stoke')
    await send('/chats\r', 'Use /attach NUMBER')
    const original = history(join(temp, 'state')).findIndex((c) => c.agent === 'opencode') + 1
    await send(`/attach ${original}\r`, 'AGENT_READY:')
    await send('EXIT_NOW', 'Chat exited (0)')
    await send('/remote lab\r', 'AGENT_READY:')
    check('remote OpenCode uses the real attach client', () => assert.match(output, /"args":\["attach","http:\/\/127.0.0.1:4096"\]/))
    await send('\x1d', 'Returned to Stoke')
    await send('\x1b[15~', 'Search chats:')
    await send('\x13', 'Search settings:')
    await send('Default agent\r', 'Agent ID')
    await send('\x15claude\x13', 'Default agent saved:')
    check('Settings saves defaults and preserves custom executable paths', () => {
      const saved = readConfig(file)
      assert.equal(saved.agent, 'claude')
      assert.equal(saved.agents.opencode.executable, fixture)
    })
    await send('Appearance\r', 'Appearance saved: ocean')
    check('appearance changes are persisted', () => assert.equal(readConfig(file).ui.theme, 'ocean'))
    await send('\x12', 'Search connections:')
    await send('\x01', 'Connection name')
    await send('staging\t\x1b[C\tfile:///bad\x13', 'Use an HTTP(S) URL')
    check('invalid connection settings stay in the form and do not change disk', () => assert.equal(readConfig(file).remotes.staging, undefined))
    await send('\x15https://example.com\x13', 'Saved staging')
    check('Connections adds a validated server without launching a network connection', () => assert.deepEqual(readConfig(file).remotes.staging, { kind: 'opencode', url: 'https://example.com' }))
    await send('staging\x05', 'Edit connection')
    await send('\t\thttps', 'SSH host / alias')
    await send('\x15https://updated.example.com\x13', 'Saved staging')
    check('Connections edits a saved server', () => assert.deepEqual(readConfig(file).remotes.staging, { kind: 'opencode', url: 'https://updated.example.com' }))
    await send('staging\x04', 'Type the connection name')
    await send('wrong\x13', 'exact connection name')
    await send('\x15staging\x13', 'Removed staging')
    check('Connections removes only the selected saved entry and keeps existing connections', () => {
      assert.equal(readConfig(file).remotes.staging, undefined)
      assert.equal(readConfig(file).remotes.lab.kind, 'opencode')
    })
    await send('\x1b[Z', 'Search models:')
    await send('\x01', 'Model ID')
    await send('provider/fast\x13', 'Saved provider/fast')
    check('Models saves a custom shortcut for the selected agent', () => assert.ok(readConfig(file).agents.claude.models.includes('provider/fast')))
    await send('\x1b', 'stoke · claude')
    const broken = join(temp, 'config.json')
    writeFileSync(broken, '{ broken')
    await send('/config reload\r', 'Invalid Stoke config')
    await send('\x15/agent opencode\r', 'Selected OpenCode')
    check('a malformed config reload preserves the previous usable configuration', () => assert.ok(output.includes('Selected OpenCode')))
    const multiline = await send('\x1b[200~alpha\nbeta\x1b[201~\r', 'AGENT_READY:')
    check('multiline paste reaches the native agent with its line break', () => assert.ok(multiline.includes(JSON.stringify('alpha\nbeta'))))
    await send('\x1d', 'Returned to Stoke')
    terminal.write('/quit\r')
    await until(() => exited, 'Clean shutdown')
    check('quitting detaches the UI and persisted metadata is private', () => {
      if (process.platform !== 'win32') for (const chat of history(join(temp, 'state'))) {
        assert.equal(statSync(join(temp, 'state/chats', `${chat.id}.json`)).mode & 0o777, 0o600)
      }
    })
    const listed = spawnSync(process.execPath, [join(root, 'src/terminal/index.ts'), 'sessions', '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const records = JSON.parse(listed.stdout) as { id: string; state: string; agent: string }[]
    const running = records.find((record) => record.state === 'running' && record.agent === 'claude')
    assert.ok(running)
    check('running sessions survive UI exit and can be listed noninteractively', () => assert.ok(running))
    const serverInfo = readServerInfo(join(temp, 'state'))!
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(serverInfo.endpoint)
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Unauthenticated local connection was not closed.')) }, 2000)
      socket.on('connect', () => socket.write(JSON.stringify({ id: 1, command: 'list', token: 'é'.repeat(64) }) + '\n'))
      socket.on('error', () => undefined)
      socket.on('close', () => { clearTimeout(timer); resolve() })
    })
    check('the session service rejects an unauthenticated local client without affecting running agents', () => assert.ok(readServerInfo(join(temp, 'state'))))
    writeFileSync(file, JSON.stringify(config))
    const count = history(join(temp, 'state')).length
    await new Promise<void>((resolve, reject) => {
      const other = spawn(process.execPath, [join(root, 'src/terminal/index.ts'), 'attach', running.id], { cwd: root, cols: 120, rows: 36, env })
      let text = '', sent = false, detached = false, quitting = false
      const timer = setTimeout(() => { other.kill(); reject(new Error(`Reattach timed out: ${text.slice(-1000)}`)) }, 8000)
      other.onData((data) => {
        text += data
        if (!sent && text.includes('AGENT_READY:')) { sent = true; other.write('reattached after quit\r') }
        if (!detached && text.includes('AGENT_INPUT:"reattached after quit\\r"')) { detached = true; other.write('\x1d') }
        if (detached && !quitting && text.includes('Returned to Stoke')) { quitting = true; other.write('/quit\r') }
      })
      other.onExit(({ exitCode }) => { clearTimeout(timer); if (process.platform === 'win32') try { other.kill() } catch { /* already released */ }; if (exitCode === 0 && detached) resolve(); else reject(new Error(`Reattach failed: ${text.slice(-1000)}`)) })
    })
    check('a second UI reattaches the original process without creating a duplicate chat', () => assert.equal(history(join(temp, 'state')).length, count))
  } finally { if (!exited) terminal.kill() }

  check('config init creates a private file once and never overwrites an existing config', () => {
    const configFile = join(temp, 'new/config.json')
    const args = ['--experimental-strip-types', join(root, 'src/terminal/index.ts'), '--config', configFile, 'config', 'init']
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    const before = readFileSync(configFile, 'utf8')
    assert.equal(spawnSync(process.execPath, args, { cwd: root }).status, 1)
    assert.equal(readFileSync(configFile, 'utf8'), before)
    const trailing = join(temp, 'trailing-config.json')
    const reordered = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'src/terminal/index.ts'), 'config', 'init', '--config', trailing], { cwd: root, encoding: 'utf8' })
    assert.equal(reordered.status, 0, reordered.stderr)
    assert.equal(JSON.parse(readFileSync(trailing, 'utf8')).agent, 'opencode')
  })
  if (process.platform !== 'win32') check('packaged macOS command runs the terminal runtime with inherited stdio', () => {
    const resources = join(temp, 'Stoke.app/Contents/Resources')
    mkdirSync(join(resources, 'bin'), { recursive: true })
    mkdirSync(join(resources, 'terminal'))
    mkdirSync(join(resources, '../MacOS'))
    copyFileSync(join(root, 'build/bin/stoke'), join(resources, 'bin/stoke'))
    writeFileSync(join(resources, 'terminal/stoke.cjs'), '// fixture')
    const exe = join(resources, '../MacOS/Stoke')
    writeFileSync(exe, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$@"\n')
    chmodSync(exe, 0o755)
    const result = spawnSync('sh', [join(resources, 'bin/stoke'), '--help'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `1\n${realpathSync(resources)}/bin/../terminal/stoke.cjs\n--help\n`)
  })
  console.log(`\n${checks} terminal checks passed (fake agents; no provider requests).`)
} catch (error) {
  console.error(error) // Preserve the original failure if a Windows handle delays cleanup.
  throw error
} finally {
  console.log('Cleaning up the synthetic session service…')
  const info = readServerInfo(join(temp, 'state'))
  const cleanup = new Sessions(() => {}, () => {}, join(temp, 'state'))
  try { if (await cleanup.ready(false)) await cleanup.shutdown() } finally { cleanup.close() }
  console.log('Synthetic session shutdown acknowledged.')
  const deadline = Date.now() + 3000
  while (info && processAlive(info.pid) && Date.now() < deadline) await new Promise(done => setTimeout(done, 30))
  assert(!info || !processAlive(info.pid), 'the synthetic session owner must exit after shutdown')
  console.log(`Synthetic session owner exited: ${!info || !processAlive(info.pid)}.`)
  rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  console.log('Synthetic fixture removed; active resource kinds:', process.getActiveResourcesInfo().join(', '))
}
