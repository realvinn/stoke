import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
if (process.platform === 'darwin') {
  mkdirSync('out/native', { recursive: true })
  const args = ['-O2', '-fobjc-arc', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-framework', 'Foundation', '-framework', 'CoreGraphics', 'native/mac-reveal.m', '-o', 'out/native/mac-reveal']
  const result = spawnSync('clang', args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  const signed = spawnSync('codesign', ['--force', '--sign', '-', 'out/native/mac-reveal'], { stdio: 'inherit' })
  if (signed.status !== 0) process.exit(signed.status ?? 1)
}
