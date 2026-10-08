import { mkdir, realpath, writeFile, open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { ScratchSettings } from '../shared/scratch.ts'

export function scratchRoot(settings: ScratchSettings, home: string, userData: string): string {
  const root = settings.directory ?? (settings.legacyLocation ? join(userData, 'scratch') : join(home, 'Stoke', 'Scratch'))
  if (!isAbsolute(root)) throw new Error('Choose an absolute path for the scratch folder.')
  return root
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The scratch location did not respond within 5 seconds.')), 5000)
    })])
  } finally { clearTimeout(timer) }
}
export async function createScratch(root: string, now = new Date()): Promise<string> {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return bounded((async () => {
    await mkdir(root, { recursive: true })
    const canonical = await realpath(root)
    for (let suffix = 1; suffix <= 10_000; suffix++) {
      const folder = join(canonical, suffix === 1 ? stamp : `${stamp}-${suffix}`)
      try { await mkdir(folder) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      await writeFile(join(folder, '.stoke-scratch.json'), JSON.stringify({ version: 1, createdAt: now.toISOString() }), { mode: 0o600 })
      return folder
    }
    throw new Error('Too many scratch folders share this timestamp.')
  })())
}
/** Only folders Stoke itself marked, regardless of later root-setting changes. */
export async function isScratch(folder: string): Promise<boolean> {
  try {
    const text = await bounded((async () => {
      const file = await open(join(folder, '.stoke-scratch.json'), 'r')
      try {
        const bytes = Buffer.alloc(1025)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        if (bytesRead > 1024) return ''
        return bytes.subarray(0, bytesRead).toString('utf8')
      } finally { await file.close() }
    })())
    const marker = JSON.parse(text) as { version?: unknown; createdAt?: unknown }
    return marker.version === 1 && typeof marker.createdAt === 'string'
  } catch { return false }
}
