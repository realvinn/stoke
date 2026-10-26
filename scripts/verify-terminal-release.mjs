import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from '@lydell/node-pty'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const target = `${process.platform}-${process.arch}`
const name = `stoke-cli-${version}-${target}`
const archive = resolve('out/cli-release', name + (process.platform === 'win32' ? '.zip' : '.tar.gz'))
assert.ok(existsSync(archive), 'Build this native release with npm run dist:terminal first.')
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
assert.equal(readFileSync(`${archive}.sha256`, 'utf8').split(' ')[0], digest)
const temp = mkdtempSync(join(tmpdir(), 'stoke extracted space-'))
const env = { ...process.env, STOKE_TERMINAL_HOME: join(temp, 'state'), STOKE_CONFIG: join(temp, 'config.json') }
let node, entry
try {
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:STOKE_ARCHIVE_SRC -DestinationPath $env:STOKE_ARCHIVE_DEST'], { env: { ...env, STOKE_ARCHIVE_SRC: archive, STOKE_ARCHIVE_DEST: temp } })
  else execFileSync('tar', ['-xzf', archive, '-C', temp])
  const release = join(temp, name)
  node = join(release, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  entry = join(release, 'lib/stoke.cjs')
  const report = JSON.parse(execFileSync(node, [entry, 'doctor', '--json'], { env, encoding: 'utf8' }))
  assert.equal(report.platform, process.platform); assert.equal(report.arch, process.arch); assert.equal(report.ok, true)
  const installRoot = join(temp, 'installed')
  const bin = process.platform === 'win32' ? join(installRoot, 'bin') : join(temp, 'commands')
  const installEnv = { ...env, STOKE_INSTALL_ROOT: installRoot, STOKE_BIN_DIR: bin }
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(release, 'install.ps1'), '-NoPath'], { env: installEnv })
    const command = join(bin, 'stoke.cmd')
    const output = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${command}" --version"`], { env: installEnv, windowsVerbatimArguments: true, encoding: 'utf8' })
    assert.match(output, new RegExp(version.replace(/\./g, '\\.')))
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(release, 'install.ps1'), '-Action', 'Uninstall', '-NoPath'], { env: installEnv })
    assert.equal(existsSync(command), false)
  } else {
    execFileSync('sh', [join(release, 'install.sh')], { env: installEnv })
    assert.match(execFileSync(join(bin, 'stoke'), ['--version'], { env: installEnv, encoding: 'utf8' }), /Stoke terminal/)
    execFileSync('sh', [join(release, 'install.sh'), 'uninstall'], { env: installEnv })
    assert.equal(existsSync(join(bin, 'stoke')), false)
  }
  await new Promise((resolve, reject) => {
    const child = spawn(node, [entry], { env, cwd: release, cols: 100, rows: 30 })
    let data = '', menu = false, quit = false
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Extracted CLI failed: ${data.slice(-2000)}`)) }, 10_000)
    child.onData((text) => {
      data += text
      if (!menu && data.includes('stoke ·')) { menu = true; child.write('\x1b[15~') }
      if (menu && !quit && data.includes('Search chats:')) { quit = true; child.write('\x1b[15~') }
      else if (quit && data.includes('Search chats:') && text.includes('stoke ·')) child.write('/quit\r')
    })
    child.onExit(({ exitCode }) => { clearTimeout(timer); if (process.platform === 'win32') try { child.kill() } catch { /* already released */ }; if (exitCode === 0 && quit) resolve(); else reject(new Error(`Extracted CLI exit ${exitCode}: ${data.slice(-1000)}`)) })
  })
  console.log(`PASS extracted ${target} release: bundled runtime, PTY, doctor, F5 and clean UI detach.`)
} finally {
  if (node && entry && existsSync(node)) try { execFileSync(node, [entry, 'server', 'stop'], { env, timeout: 5000 }) } catch { /* already stopped */ }
  rmSync(temp, { recursive: true, force: true })
}
