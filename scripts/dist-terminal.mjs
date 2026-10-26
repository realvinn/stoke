import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { TERMINAL_TARGETS } from '../src/terminal/targets.ts'

const root = resolve(import.meta.dirname, '..')
const target = TERMINAL_TARGETS.find((entry) => entry.id === `${process.platform}-${process.arch}`)
if (!target) throw new Error(`No mainstream CLI build for ${process.platform}-${process.arch}. Supported: ${TERMINAL_TARGETS.map((t) => t.id).join(', ')}`)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtime = JSON.parse(readFileSync(join(root, 'build/terminal-runtime.json'), 'utf8'))
const asset = runtime.assets[target.id]
const output = join(root, 'out/cli-release')
const name = `stoke-cli-${pkg.version}-${target.id}`
const stage = join(root, 'out/portable', name)
mkdirSync(output, { recursive: true })
mkdirSync(join(stage, 'runtime'), { recursive: true })
mkdirSync(join(stage, 'lib'), { recursive: true })
const cache = join(root, 'out/runtime-cache')
mkdirSync(cache, { recursive: true })
const archive = join(cache, asset.file)
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
if (!existsSync(archive) || sha(archive) !== asset.sha256) {
  const response = await fetch(`https://nodejs.org/dist/v${runtime.version}/${asset.file}`, { signal: AbortSignal.timeout(120_000), redirect: 'error' })
  if (!response.ok) throw new Error(`Node runtime download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Node runtime SHA-256 differs from the pinned release digest.')
  writeFileSync(archive, bytes)
}
const unpack = mkdtempSync(join(tmpdir(), 'stoke-runtime-'))
try {
  if (target.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:STOKE_ARCHIVE_SRC -DestinationPath $env:STOKE_ARCHIVE_DEST'], {
      env: { ...process.env, STOKE_ARCHIVE_SRC: archive, STOKE_ARCHIVE_DEST: unpack }, stdio: 'inherit'
    })
  } else execFileSync('tar', ['-xzf', archive, '-C', unpack])
  const extracted = join(unpack, asset.file.replace(/\.(zip|tar\.gz)$/, ''))
  copyFileSync(join(extracted, target.platform === 'win32' ? 'node.exe' : 'bin/node'), join(stage, 'runtime', target.platform === 'win32' ? 'node.exe' : 'node'))
  copyFileSync(join(extracted, 'LICENSE'), join(stage, 'runtime/LICENSE'))
} finally { rmSync(unpack, { recursive: true, force: true }) }

for (const dependency of ['@lydell/node-pty', `@lydell/node-pty-${target.id}`]) {
  const source = join(root, 'node_modules', dependency)
  const meta = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (meta.os && (!meta.os.includes(process.platform) || !meta.cpu.includes(process.arch))) throw new Error(`Wrong native PTY package: ${dependency}`)
  cpSync(source, join(stage, 'node_modules', dependency), { recursive: true, force: true })
}
copyFileSync(join(root, 'out/terminal/stoke.cjs'), join(stage, 'lib/stoke.cjs'))
for (const file of ['README.md', 'LICENSE', 'THIRD-PARTY.txt']) copyFileSync(join(root, 'out/terminal-package', file), join(stage, file))
copyFileSync(join(root, 'install/cli.sh'), join(stage, 'install.sh'))
copyFileSync(join(root, 'install/cli.ps1'), join(stage, 'install.ps1'))
writeFileSync(join(stage, 'stoke'), `#!/bin/sh
set -eu
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
root=$(CDPATH= cd -- "$(dirname "$self")" && pwd)
export PATH="$PATH:$root/runtime"
exec "$root/runtime/node" "$root/lib/stoke.cjs" "$@"
`)
writeFileSync(join(stage, 'stoke.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PATH=%PATH%;%~dp0runtime"\r\n"%~dp0runtime\\node.exe" "%~dp0lib\\stoke.cjs" %*\r\nexit /b %errorlevel%\r\n')
if (target.platform !== 'win32') for (const file of ['stoke', 'install.sh', 'runtime/node']) chmodSync(join(stage, file), 0o755)
writeFileSync(join(stage, 'release.json'), JSON.stringify({ version: pkg.version, target: target.id, node: runtime.version, libc: target.platform === 'linux' ? 'glibc' : null }, null, 2) + '\n')
const file = `${name}${target.platform === 'win32' ? '.zip' : '.tar.gz'}`
const dest = join(output, file)
if (target.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:STOKE_ARCHIVE_SRC -DestinationPath $env:STOKE_ARCHIVE_DEST -Force'], {
  env: { ...process.env, STOKE_ARCHIVE_SRC: stage, STOKE_ARCHIVE_DEST: dest }, stdio: 'inherit'
})
else execFileSync('tar', ['-czf', dest, '-C', dirname(stage), name])
writeFileSync(`${dest}.sha256`, `${sha(dest)}  ${file}\n`)
console.log(`Portable CLI: ${dest}`)
