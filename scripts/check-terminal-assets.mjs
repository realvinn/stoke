import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TERMINAL_TARGETS } from '../src/terminal/targets.ts'

/** A missing architecture or damaged archive must stop publication. */
export function checkTerminalAssets(dir, version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '')) throw new Error('Provide the exact release version.')
  for (const target of TERMINAL_TARGETS) {
    const name = `stoke-cli-${version}-${target.id}${target.platform === 'win32' ? '.zip' : '.tar.gz'}`
    const data = readFileSync(join(dir, name))
    if (!data.length) throw new Error(`Empty CLI archive: ${name}`)
    const digest = createHash('sha256').update(data).digest('hex')
    if (readFileSync(join(dir, name + '.sha256'), 'utf8').trim() !== `${digest}  ${name}`) throw new Error(`CLI checksum mismatch: ${name}`)
  }
  return TERMINAL_TARGETS.length
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = checkTerminalAssets(process.argv[2], process.argv[process.argv.indexOf('--version') + 1])
  console.log(`Verified ${count} CLI archives and their SHA-256 checksums.`)
}
