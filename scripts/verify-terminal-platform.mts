import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from '@lydell/node-pty'
import { stripVTControlCharacters } from 'node:util'
import { createServer } from 'node:net'
import { npmShimEntry, terminalSpawnSpec, TERMINAL_TARGETS } from '../src/terminal/platform.ts'
import { sameToken } from '../src/terminal/sessionProtocol.ts'
import { AgentInput } from '../src/terminal/input.ts'
import { checkConnection } from '../src/terminal/connections.ts'
import { createHash } from 'node:crypto'
import { checkTerminalAssets } from './check-terminal-assets.mjs'

const temp = mkdtempSync(join(tmpdir(), 'stoke platform space-'))
try {
  assert.equal(new Set(TERMINAL_TARGETS.map((entry) => entry.id)).size, 6)
  const runtime = JSON.parse(readFileSync('build/terminal-runtime.json', 'utf8'))
  for (const target of TERMINAL_TARGETS) assert.match(runtime.assets[target.id].sha256, /^[a-f0-9]{64}$/)
  const version = '1.2.3-beta.1'
  const names = TERMINAL_TARGETS.map(target => `stoke-cli-${version}-${target.id}${target.platform === 'win32' ? '.zip' : '.tar.gz'}`)
  for (const name of names) {
    const bytes = Buffer.from(name)
    writeFileSync(join(temp, name), bytes)
    writeFileSync(join(temp, name + '.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
  }
  assert.equal(checkTerminalAssets(temp, version), 6)
  rmSync(join(temp, names[0]))
  assert.throws(() => checkTerminalAssets(temp, version), /ENOENT/, 'a missing native build stops publication')
  writeFileSync(join(temp, names[0]), 'corrupted archive')
  assert.throws(() => checkTerminalAssets(temp, version), /checksum mismatch/, 'damaged assets stop publication')
  assert.equal(sameToken('é'.repeat(64), 'a'.repeat(64)), false)
  assert.equal(new AgentInput('f6').take('\x1b[17~').menu, true)
  assert.equal(new AgentInput('ctrl-backslash').take('\x1c').menu, true)
  assert.equal(new AgentInput('ctrl-backslash').take('\x1b[200~\x1c\x1b[201~').detach, false)
  const js = join(temp, 'agent.mjs')
  writeFileSync(js, 'console.log("STOKE_ARGS:"+JSON.stringify(process.argv.slice(2)));')
  const shim = join(temp, 'agent.cmd')
  writeFileSync(shim, '@echo off\r\nnode "%~dp0\\agent.mjs" %*\r\n')
  assert.equal(npmShimEntry(shim), js)
  const args = ['a b', 'hello "world"', 'x&y|z', '%PATH%', '!name!', 'C:\\ends\\', '你好 👋']
  const spec = terminalSpawnSpec(process.platform === 'win32' ? shim : process.execPath, process.platform === 'win32' ? args : [js, ...args])
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.file, spec.args, { cols: 240, rows: 24 })
    let data = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('native launch timed out')) }, 5000)
    child.onData((text) => { data += text })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      try { assert.equal(exitCode, 0); assert.deepEqual(JSON.parse(stripVTControlCharacters(data).match(/STOKE_ARGS:(\[[^\r\n]*\])/)![1]), args); resolve() } catch (error) { reject(error) }
    })
  })
  if (process.platform === 'win32') {
    const generic = join(temp, 'ordinary launcher.cmd')
    writeFileSync(generic, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
    const parsed = terminalSpawnSpec(generic, ['hello world', 'x&y'])
    await new Promise<void>((resolve, reject) => {
      const child = spawn(parsed.file, parsed.args, { cols: 240, rows: 24 })
      let data = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('batch launch timed out')) }, 5000)
      child.onData((text) => { data += text })
      child.onExit(({ exitCode }) => {
        clearTimeout(timer)
        try { assert.equal(exitCode, 0); assert.deepEqual(JSON.parse(stripVTControlCharacters(data).match(/STOKE_ARGS:(\[[^\r\n]*\])/)![1]), ['hello world', 'x&y']); resolve() } catch (error) { reject(error) }
      })
    })
  } else chmodSync(js, 0o600)
  const matrix = JSON.parse(execFileSync(process.execPath, ['src/terminal/targets.ts', '--matrix'], { encoding: 'utf8' }))
  assert.equal(matrix.include.length, 6)
  const listener = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const check = await checkConnection({ kind: 'opencode', url: `http://127.0.0.1:${address.port}` })
    assert.equal(check.ok, true)
    assert.match(check.message, /Authentication.*when you connect/)
  } finally { await new Promise<void>((resolve) => listener.close(() => resolve())) }
  console.log(`PASS native launch, spaces, quotes, Unicode, architecture manifest and local auth on ${process.platform}-${process.arch}`)
} finally { rmSync(temp, { recursive: true, force: true }) }
