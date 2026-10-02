import { clipboard, ipcMain, nativeImage, type WebContents } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { CH } from '@shared/ipc'
import type { ImagePrepared, ImageSent } from '@shared/api'
import type { Settings, SshHost } from '@shared/types'
import {
  MAX_IMAGE_BYTES,
  clipboardImageName,
  droppedImageName,
  formatBytes,
  imageKind,
  isSafeUploadName
} from '@shared/imageUpload'
import { sendImage } from './sshUpload.ts'

/**
 * The IPC half of images into an SSH tab: prepare (read, check, name, hold),
 * send, cancel. Its own module so index.ts carries two lines for it.
 *
 * Two steps rather than one so the strip can show WHAT is being sent — a
 * thumbnail of a clipboard the user cannot otherwise see — while it sends,
 * and so a failed image can be sent again without reading the clipboard
 * again (it may have changed).
 *
 * Everything that reaches the far machine is decided here: the host comes from
 * settings by id, the name and extension from `clipboardImageName` /
 * `droppedImageName` and the magic bytes, the size from the bytes. The
 * renderer never sends a path, and the only thing it names is the id main
 * handed it.
 */

interface Held {
  hostId: string
  name: string
  bytes: Uint8Array
  /** Set while a send is in flight: the claim (gotcha 20) and Cancel's handle. */
  abort: AbortController | null
  expiry: ReturnType<typeof setTimeout> | null
}

/** A held image no one sends or cancels is dropped after this. */
const HELD_MS = 10 * 60_000
/** The thumbnail's longest side, in pixels: shown at half that, so it is sharp at 2x. */
const THUMB_PX = 96

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
  if (host.noUploads === true) return 'Images are not sent to this machine (Settings › SSH hosts).'
  return null
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
    const h: Held = { hostId: host.id, name, bytes, abort: null, expiry: null }
    held.set(uploadId, h)
    keep(uploadId, h)
    return { ok: true, uploadId, name, bytes: bytes.byteLength, thumb: thumbnailOf(bytes) }
  })

  ipcMain.handle(CH.sshImageSend, async (e, uploadId: unknown): Promise<ImageSent> => {
    if (!deps.isAppWindow(e.sender)) return { ok: false, reason: 'not-allowed', message: 'Not from this window.', detail: '' }
    const id = typeof uploadId === 'string' ? uploadId : ''
    const h = held.get(id)
    // Gone (let go after HELD_MS, or cancelled): never `failed`, whose answer is
    // Try again — that would only ask main for it again, and again.
    if (!h) return { ok: false, reason: 'not-allowed', message: 'That image is no longer waiting to be sent. Paste it again.', detail: '' }
    // Claimed before the first await (gotcha 20): a second press is refused, not a second send.
    if (h.abort) return { ok: false, reason: 'failed', message: 'That image is already being sent.', detail: '' }
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
      const r = await sendImage(host, h.name, h.bytes, { signal: ac.signal })
      if (r.ok || r.reason === 'cancelled' || r.reason === 'not-allowed') drop(id)
      else if (held.get(id) === h) {
        // Kept for Try again, unless a Cancel dropped it meanwhile.
        h.abort = null
        keep(id, h)
      }
      return r
    } catch (err) {
      drop(id)
      return { ok: false, reason: 'failed', message: 'The image was not sent.', detail: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(CH.sshImageCancel, (e, uploadId: unknown): void => {
    if (!deps.isAppWindow(e.sender) || typeof uploadId !== 'string') return
    held.get(uploadId)?.abort?.abort()
    drop(uploadId)
  })
}
