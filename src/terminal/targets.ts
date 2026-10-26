import { pathToFileURL } from 'node:url'
import { appendFileSync } from 'node:fs'

export const TERMINAL_TARGETS = [
  { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15', label: 'macOS Apple Silicon' },
  { id: 'darwin-x64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel', label: 'macOS Intel' },
  { id: 'win32-x64', platform: 'win32', arch: 'x64', runner: 'windows-latest', label: 'Windows x64' },
  { id: 'win32-arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm', label: 'Windows ARM64' },
  { id: 'linux-x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04', label: 'Linux x64' },
  { id: 'linux-arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm', label: 'Linux ARM64' }
] as const

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--matrix')) process.stdout.write(JSON.stringify({ include: TERMINAL_TARGETS }) + '\n')
  if (process.argv.includes('--github-matrix') && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: TERMINAL_TARGETS })}\n`)
}
