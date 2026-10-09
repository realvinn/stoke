import { MAX_FILE_BYTES } from './imageUpload.ts'

export { MAX_FILE_BYTES }
export interface PhoneFileEntry { name: string; path: string; kind: 'file' | 'folder'; size: number | null }
export interface PhoneFileListing { path: string; entries: PhoneFileEntry[]; truncated: boolean }
export interface PhoneFileSent { path: string; name: string; size: number; destination: 'local' | 'ssh' }

export function phoneFileNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') return 'Choose one file with a valid name.'
  return null
}
/** Paths are relative to the session folder; root is the empty string. */
export function phoneRelativePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 2048 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    (path === '' || path.split('/').every((part) => !!part && part !== '.' && part !== '..'))
}
export function phoneFileSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_BYTES
}
