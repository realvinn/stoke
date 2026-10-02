import { clipboard, ipcMain, nativeImage, type WebContents } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { CH } from '@shared/ipc'
import type { ImagePrepared, ImageSent, UploadProgress } from '@shared/api'
import type { Settings, SshHost } from '@shared/types'
import {
  MAX_IMAGE_BYTES,
  cidaCount,
  clipboardImageName,
  droppedFileName,
  droppedImageName,
  fileNameW,
  fileUrlPath,
  formatBytes,
  imageKind,
  isSafeFarName,
  isSafeUploadName,
  parseFilenamesPlist,
  parseUriList
} from '@shared/imageUpload'
import { inspectUploadFile, sendFile, sendImage } from './sshUpload.ts'

/**
 * The IPC half of images and files into an SSH tab: prepare (read, check,
 * name, hold), send, cancel. Its own module so index.ts carries two lines for
 * it.
 *
 * Two steps rather than one so the strip can show WHAT is being sent — a
 * thumbnail of a clipboard the user cannot otherwise see, a file's own name —
 * while it sends, and so a failed one can be sent again without reading the
 * clipboard again (it may have changed).
 *
 * Everything that reaches the far machine is decided here: the host comes from
 * settings by id, an image's name and extension from `clipboardImageName` /
 * `droppedImageName` and the magic bytes, a file's from `droppedFileName`,
 * the size from the bytes or the file. The renderer never writes a path: a
 * dropped file's comes from the preload's `webUtils.getPathForFile`, a copied
 * file's from the clipboard, read here. The only thing it names is the id
 * main handed it.
 */

interface Held {
  hostId: string
  name: string
  /** An image's bytes, read and checked when it was pasted or dropped. */
  bytes: Uint8Array | null
  /**
   * A file: the path every link resolved to, the name the user knows it by,
   * and its size when it was checked. Read when it is SENT (`sendFile`
   * checks it again then), so a queue of big files is never all in memory.
   */
  file: { path: string; label: string; size: number } | null
  /** Set while a send is in flight: the claim (gotcha 20) and Cancel's handle. */
  abort: AbortController | null
  expiry: ReturnType<typeof setTimeout> | null
}

/** A held image no one sends or cancels is dropped after this. */
const HELD_MS = 10 * 60_000
/** The thumbnail's longest side, in pixels: shown at half that, so it is sharp at 2x. */
const THUMB_PX = 96
/** How often progress is pushed while a send runs (and once more at the end). */
const PROGRESS_MS = 150
/** The most files one paste takes; past it, a sentence says to send them another way. */
const MAX_PASTED_FILES = 50

/**
 * The files Finder, Explorer or a Linux file manager copied, as paths, read
 * here and nowhere else. `count` is how many were copied, which on Windows can
 * be more than the one path Electron can read there (`cidaCount`); the
 * shared module's note has what each platform offers and what was measured.
 */
export function clipboardFiles(): { paths: string[]; count: number } {
  try {
    if (process.platform === 'darwin') {
      const all = parseFilenamesPlist(clipboard.read('NSFilenamesPboardType'))
      if (all.length) return { paths: all, count: all.length }
      const one = fileUrlPath(clipboard.read('public.file-url'))
      return one ? { paths: [one], count: 1 } : { paths: [], count: 0 }
    }
    if (process.platform === 'win32') {
      const first = fileNameW(clipboard.readBuffer('FileNameW'))
      if (!first) return { paths: [], count: 0 }
      return { paths: [first], count: Math.max(1, cidaCount(clipboard.readBuffer('Shell IDList Array'))) }
    }
    let paths = parseUriList(clipboard.readBuffer('text/uri-list').toString('utf8'))
    // GNOME Files' own target: "copy" or "cut", then one URI a line.
    if (!paths.length) paths = parseUriList(clipboard.readBuffer('x-special/gnome-copied-files').toString('utf8').split('\n').slice(1).join('\n'))
    return { paths, count: paths.length }
  } catch {
    return { paths: [], count: 0 }
  }
}

/**
 * The clipboard formats that hold a PNG as PNG bytes, per platform. Read first,
 * because a macOS screenshot copied to the clipboard is already a PNG and
 * `readImage().toPNG()` would decode and re-encode it on the main thread.
 */
const PNG_FORMATS: Record<string, string[]> = {
  darwin: ['public.png'],
  win32: ['PNG'],
  linux: ['image/png']
}

function clipboardImage(): Uint8Array | null {
  for (const format of PNG_FORMATS[process.platform] ?? []) {
    try {
      const raw = clipboard.readBuffer(format)
      if (raw.length && imageKind(raw) === 'png') return raw
    } catch {
      /* not offered here; fall through to the decoded image */
    }
  }
  const img = clipboard.readImage()
  return img.isEmpty() ? null : img.toPNG()
}

function thumbnailOf(bytes: Uint8Array): string | null {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const scale = Math.min(1, THUMB_PX / Math.max(width, height, 1))
    const small =
      scale < 1
        ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
        : img
    return small.toDataURL()
  } catch {
    return null
  }
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

function hostRefusal(host: SshHost | undefined): string | null {
  if (!host) return 'That machine is not in Settings.'
  if (host.noUploads === true) return 'Images and files are not sent to this machine (Settings › SSH hosts).'
  return null
}

/** A push of `UploadProgress`, at most every `PROGRESS_MS` and always the last. */
function progressTo(sender: WebContents, uploadId: string, total: number): (sent: number) => void {
  let last = 0
  return (sent) => {
    const now = Date.now()
    if (sent < total && now - last < PROGRESS_MS) return
    last = now
    if (sender.isDestroyed()) return
    const p: UploadProgress = { uploadId, sent, total }
    sender.send(CH.sshUploadProgress, p)
  }
}

export function registerSshImageHandlers(deps: {
  getSettings: () => Settings
  /** Only Stoke's own window may send files to a machine. */
  isAppWindow: (sender: WebContents) => boolean
}): void {
  const held = new Map<string, Held>()
  const drop = (id: string): void => {
    const h = held.get(id)
    if (!h) return
    if (h.expiry) clearTimeout(h.expiry)
    held.delete(id)
  }
  const keep = (id: string, h: Held): void => {
    if (h.expiry) clearTimeout(h.expiry)
    h.expiry = setTimeout(() => {
      if (!held.get(id)?.abort) held.delete(id)
    }, HELD_MS)
  }

  ipcMain.handle(CH.sshImagePrepare, (e, hostId: unknown, source: unknown): ImagePrepared => {
    if (!deps.isAppWindow(e.sender)) return { ok: false, reason: 'not-allowed', message: 'Not from this window.' }
    const host = typeof hostId === 'string' ? deps.getSettings().hosts.find((h) => h.id === hostId) : undefined
    const refusal = hostRefusal(host)
    if (refusal || !host) return { ok: false, reason: 'not-allowed', message: refusal ?? '' }
    const src = source && typeof source === 'object' ? (source as { kind?: unknown; name?: unknown; data?: unknown }) : {}
    const hex = randomBytes(3).toString('hex')

    let bytes: Uint8Array | null
    let name: string
    if (src.kind === 'clipboard') {
      bytes = clipboardImage()
      if (!bytes) return { ok: false, reason: 'no-image', message: 'There is no image on the clipboard.' }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return { ok: false, reason: 'too-large', message: `That image is ${formatBytes(bytes.byteLength)}; Stoke sends images up to ${formatBytes(MAX_IMAGE_BYTES)}.` }
      }
      name = clipboardImageName(new Date(), hex, imageKind(bytes) ?? 'png')
    } else if (src.kind === 'bytes') {
      bytes = bytesOf(src.data)
      const label = typeof src.name === 'string' && src.name ? src.name : 'That file'
      if (!bytes) return { ok: false, reason: 'not-image', message: `${label} could not be read.` }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return { ok: false, reason: 'too-large', message: `${label} is ${formatBytes(bytes.byteLength)}; Stoke sends images up to ${formatBytes(MAX_IMAGE_BYTES)}.` }
      }
      const kind = imageKind(bytes)
      if (!kind) return { ok: false, reason: 'not-image', message: `${label} is not a PNG, JPEG, GIF or WebP image.` }
      name = droppedImageName(typeof src.name === 'string' ? src.name : '', hex, kind)
    } else {
      return { ok: false, reason: 'not-allowed', message: 'Nothing to send.' }
    }
    if (!isSafeUploadName(name) || bytes.byteLength === 0) {
      return { ok: false, reason: 'not-allowed', message: 'Stoke could not name that image safely.' }
    }

    const uploadId = randomUUID()
    const h: Held = { hostId: host.id, name, bytes, file: null, abort: null, expiry: null }
    held.set(uploadId, h)
    keep(uploadId, h)
    return { ok: true, uploadId, name, bytes: bytes.byteLength, thumb: thumbnailOf(bytes) }
  })

  /**
   * A FILE, by its path (gotcha 152): checked now — a regular file, through
   * every link, within the cap — named after itself, and held as the path,
   * read only when its turn to send comes.
   */
  const holdFile = async (host: SshHost, path: string): Promise<ImagePrepared> => {
    const label = basename(path) || 'That file'
    const check = await inspectUploadFile(path, label)
    if (!check.ok) return { ok: false, reason: check.reason, message: check.message }
    const name = droppedFileName(label, randomBytes(3).toString('hex'))
    if (!isSafeFarName(name)) return { ok: false, reason: 'not-allowed', message: `Stoke could not name ${label} safely.` }
    const uploadId = randomUUID()
    const h: Held = { hostId: host.id, name, bytes: null, file: { path: check.path, label, size: check.size }, abort: null, expiry: null }
    held.set(uploadId, h)
    keep(uploadId, h)
    return { ok: true, uploadId, name, bytes: check.size, thumb: null, file: label }
  }

  ipcMain.handle(CH.sshFilePrepare, async (e, hostId: unknown, path: unknown): Promise<ImagePrepared> => {
    if (!deps.isAppWindow(e.sender)) return { ok: false, reason: 'not-allowed', message: 'Not from this window.' }
    const host = typeof hostId === 'string' ? deps.getSettings().hosts.find((h) => h.id === hostId) : undefined
    const refusal = hostRefusal(host)
    if (refusal || !host) return { ok: false, reason: 'not-allowed', message: refusal ?? '' }
    if (typeof path !== 'string') return { ok: false, reason: 'not-file', message: 'That is not a file on this computer.' }
    return holdFile(host, path)
  })

  /*
   * Files copied in the file manager, read off the clipboard HERE at the press
   * (the renderer only says "the clipboard"), each checked and held in the
   * order they were copied. Every answer is one entry; a refusal of the whole
   * paste is a list of one.
   */
  ipcMain.handle(CH.sshClipboardFilesPrepare, async (e, hostId: unknown): Promise<ImagePrepared[]> => {
    if (!deps.isAppWindow(e.sender)) return [{ ok: false, reason: 'not-allowed', message: 'Not from this window.' }]
    const host = typeof hostId === 'string' ? deps.getSettings().hosts.find((h) => h.id === hostId) : undefined
    const refusal = hostRefusal(host)
    if (refusal || !host) return [{ ok: false, reason: 'not-allowed', message: refusal ?? '' }]
    const { paths, count } = clipboardFiles()
    if (!count) return [{ ok: false, reason: 'no-file', message: 'There is no file on the clipboard.' }]
    if (count > paths.length) {
      return [{ ok: false, reason: 'not-allowed', message: `Stoke can read only the first of the ${count} files copied here. Drop them on the tab instead, or copy one at a time.` }]
    }
    if (count > MAX_PASTED_FILES) {
      return [{ ok: false, reason: 'too-large', message: `That is ${count} files; Stoke sends up to ${MAX_PASTED_FILES} at once. Copy them with scp instead.` }]
    }
    const out: ImagePrepared[] = []
    for (const p of paths) out.push(await holdFile(host, p))
    return out
  })

  ipcMain.handle(CH.sshImageSend, async (e, uploadId: unknown): Promise<ImageSent> => {
    if (!deps.isAppWindow(e.sender)) return { ok: false, reason: 'not-allowed', message: 'Not from this window.', detail: '' }
    const id = typeof uploadId === 'string' ? uploadId : ''
    const h = held.get(id)
    // Gone (let go after HELD_MS, or cancelled): never `failed`, whose answer is
    // Try again — that would only ask main for it again, and again.
    if (!h) return { ok: false, reason: 'not-allowed', message: 'That is no longer waiting to be sent. Paste or drop it again.', detail: '' }
    // Claimed before the first await (gotcha 20): a second press is refused, not a second send.
    if (h.abort) return { ok: false, reason: 'failed', message: 'That is already being sent.', detail: '' }
    const host = deps.getSettings().hosts.find((x) => x.id === h.hostId)
    const refusal = hostRefusal(host)
    if (refusal || !host) {
      drop(id)
      return { ok: false, reason: 'not-allowed', message: refusal ?? '', detail: '' }
    }
    const ac = new AbortController()
    h.abort = ac
    if (h.expiry) clearTimeout(h.expiry)
    h.expiry = null
    try {
      const opts = { signal: ac.signal, onProgress: progressTo(e.sender, id, h.file ? h.file.size : (h.bytes?.byteLength ?? 0)) }
      const r = h.file
        ? await sendFile(host, h.name, h.file.path, h.file.label, opts)
        : h.bytes
          ? await sendImage(host, h.name, h.bytes, opts)
          : ({ ok: false, reason: 'not-allowed', message: 'Nothing is held to send.', detail: '' } as const)
      if (r.ok || r.reason === 'cancelled' || r.reason === 'not-allowed' || r.reason === 'not-file') drop(id)
      else if (held.get(id) === h) {
        // Kept for Try again, unless a Cancel dropped it meanwhile.
        h.abort = null
        keep(id, h)
      }
      return r
    } catch (err) {
      drop(id)
      return { ok: false, reason: 'failed', message: 'It was not sent.', detail: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(CH.sshImageCancel, (e, uploadId: unknown): void => {
    if (!deps.isAppWindow(e.sender) || typeof uploadId !== 'string') return
    held.get(uploadId)?.abort?.abort()
    drop(uploadId)
  })
}
