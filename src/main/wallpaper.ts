import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/**
 * Stoke's own copy of the wallpaper.
 *
 * The picked file is copied under userData rather than referenced where it
 * was: a photo moved or deleted later would otherwise break the theme with no
 * error anywhere, and a path in settings.json that names somewhere outside
 * Stoke's own directory is also exactly what the custom `stoke-asset` scheme
 * must not serve. The copy is named by its content hash, so picking the same
 * image twice costs nothing and the previous copy is removed on every pick.
 *
 * Electron-free apart from the userData path passed in, so a suite could run
 * it against a temp directory.
 */

export const WALLPAPER_SCHEME = 'stoke-asset'
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])
/** A wallpaper past this is a mistake, not a picture: it is read into memory to hash. */
const MAX_BYTES = 40 * 1024 * 1024

export function wallpaperDir(userData: string): string {
  return join(userData, 'wallpaper')
}

/** Copy `source` in, drop any other copy, and return the stored path. */
export async function storeWallpaper(userData: string, source: string): Promise<string> {
  const ext = extname(source).toLowerCase()
  if (!ALLOWED.has(ext)) throw new Error(`Not an image Stoke can show: ${basename(source)}`)
  const size = (await stat(source)).size
  if (size > MAX_BYTES) throw new Error('That image is over 40 MB. Pick a smaller one.')
  const bytes = await readFile(source)
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  const dir = wallpaperDir(userData)
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${hash}${ext}`)
  await copyFile(source, target)
  await clearWallpaper(userData, target)
  return target
}

/** Remove every stored copy except `keep`. */
export async function clearWallpaper(userData: string, keep: string | null = null): Promise<void> {
  const dir = wallpaperDir(userData)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names
      .map((n) => join(dir, n))
      .filter((p) => p !== keep)
      .map((p) => rm(p, { force: true }))
  )
}

/**
 * The file a `stoke-asset://wallpaper/<name>` request may read, or null.
 *
 * Only a bare file name inside the wallpaper directory: `..`, separators and
 * anything not in the allowlist are refused, so the scheme cannot be turned
 * into a file reader by a page that can inject a URL.
 */
export function wallpaperFileFor(userData: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${WALLPAPER_SCHEME}:` || url.host !== 'wallpaper') return null
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  if (!ALLOWED.has(extname(name).toLowerCase())) return null
  return join(wallpaperDir(userData), name)
}

export function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.avif':
      return 'image/avif'
    default:
      return 'application/octet-stream'
  }
}
