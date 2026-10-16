import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertWindowsIdentityImage, WINDOWS_IDENTITY_LIBRARY_NAME } from './build-windows-identity.mjs'

/** Inspect every actual packaged Resources directory found by the PTY gate. */
export function assertPackagedWindowsIdentity(ptyHits) {
  if (!ptyHits.length) throw new Error('No packaged Windows resources were found for the identity library')
  for (const hit of ptyHits) {
    const resources = dirname(dirname(dirname(hit.path)))
    const library = join(resources, 'windows-identity', WINDOWS_IDENTITY_LIBRARY_NAME)
    assertWindowsIdentityImage(readFileSync(library))
  }
  console.log(`The AnyCPU Windows identity library is present in all ${ptyHits.length} packaged output(s).`)
}
