/**
 * Images into an SSH session: the rules both processes need.
 *
 * A pasted or dropped image cannot reach a `claude` on another machine through
 * the terminal — there is no image protocol on a pty, and the far side cannot
 * read this machine's clipboard. So Stoke copies the bytes there over a second,
 * BatchMode ssh connection (`buildUploadArgs`, ssh.ts; `sendImage`,
 * sshUpload.ts) and types the far path, which Claude Code attaches the way it
 * attaches any image path in a paste.
 *
 * Everything that becomes part of a remote command is decided in main: the
 * name, the extension (from the bytes, never from a file name) and the size.
 * The renderer sends a host id and either "the clipboard" or bytes; it never
 * sends a path or a name main would use as it is.
 *
 * Pure and dependency-free (gotcha 27: compiled by both projects; gotcha 78:
 * imported by suites by relative path).
 */

/**
 * The largest image Stoke sends. Claude Code downsizes what it attaches anyway
 * (to roughly 3.75 MB raw), so anything bigger is only a longer wait on a slow
 * link; past this it is refused with a sentence rather than sent.
 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export type ImageKind = 'png' | 'jpg' | 'gif' | 'webp'

/**
 * What the bytes ARE, from their magic numbers, or null for anything that is
 * not one of the four formats Claude Code reads (`.png .jpg .jpeg .gif .webp`).
 * A file's own name and MIME type are never trusted for this: the extension
 * Stoke writes on the far side comes from here alone.
 */
export function imageKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'png'
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return 'gif'
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'webp'
  }
  return null
}

/**
 * The only names Stoke writes on another machine. Refused, never escaped (the
 * rule `isSafeSessionId` and `isSafeRemoteSessionName` already follow): the
 * name goes inside a double-quoted path in a `sh -c '…'` body, so it may hold
 * nothing a shell reads — no quote, `$`, backtick, backslash, space or slash —
 * and it starts with a letter or digit, so it is never an option or hidden.
 */
const SAFE_UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function isSafeUploadName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_UPLOAD_NAME.test(name) && /\.(png|jpg|gif|webp)$/.test(name)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * `pasted-image-20261002-143005-a1b2c3.png`: local time, so it sorts and reads
 * the way the user remembers pasting, plus six hex digits so two pastes in one
 * second do not meet. `hex` comes from main's random bytes.
 */
export function clipboardImageName(now: Date, hex: string, kind: ImageKind = 'png'): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-image-${stamp}-${hex.replace(/[^0-9a-f]/g, '').slice(0, 6)}.${kind}`
}

/**
 * A dropped file's name, kept recognisable: its stem cut down to the safe
 * alphabet (anything else becomes `-`, runs collapse, at most 48 characters,
 * no leading dot or dash), then six hex digits and the extension its BYTES
 * say. `Screenshot 2026-10-02 at 2.30.05 pm.png` becomes
 * `Screenshot-2026-10-02-at-2.30.05-pm-a1b2c3.png`.
 */
export function droppedImageName(fileName: string, hex: string, kind: ImageKind): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 48)
    .replace(/[.-]+$/, '')
  return `${stem || 'image'}-${hex.replace(/[^0-9a-f]/g, '').slice(0, 6)}.${kind}`
}

/**
 * Whether a dropped file is worth reading as an image at all, before its bytes
 * are read: by the type the OS gave it, else by its extension. Only a hint —
 * main checks the bytes (`imageKind`) and refuses anything else.
 */
export function looksLikeImageFile(name: string, type: string): boolean {
  if (/^image\/(png|jpe?g|gif|webp)$/i.test(type)) return true
  return /\.(png|jpe?g|gif|webp)$/i.test(name)
}

/** "2.1 MB", "340 KB", "812 B" — what the strip says while it sends. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/**
 * How long one send may take before it is given up: 15 s to connect and
 * settle, plus the bytes at 150 KB/s (a poor uplink), at most two minutes.
 */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(120_000, 15_000 + Math.ceil(bytes / (150 * 1024)) * 1000)
}

/**
 * Where the far side said it put the file: the LAST `STOKE_PATH ` line, since a
 * login shell's rc files may print to stdout too. The path is text another
 * machine sent, so it is accepted only if it is absolute, ends in exactly the
 * name Stoke chose, and holds no control character (a newline typed into a
 * prompt is Enter, gotcha 59).
 */
export function parseUploadPath(stdout: string, name: string): string | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('STOKE_PATH '))
  const last = lines.pop()
  if (!last) return null
  const path = last.slice('STOKE_PATH '.length)
  if (!path.startsWith('/') || !path.endsWith(`/${name}`) || path.length > 4096) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return null
  return path
}

export type UploadFailureKind = 'needs-login' | 'unreachable' | 'failed'

/**
 * Sort a failed send by ssh's own words, never by a guess (CLAUDE.md: never
 * print a diagnosis the tool can disprove). `needs-login` only on ssh's exact
 * "Permission denied" — BatchMode cannot type a password, and the answer to
 * that is a key (the existing enrollment). `unreachable` only on the network
 * failures ssh names. Everything else is `failed`, with ssh's line shown.
 */
export function uploadFailureKind(code: number | null, stderr: string): UploadFailureKind {
  if (code === 255 && /Permission denied \(/.test(stderr)) return 'needs-login'
  if (
    code === 255 &&
    /Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|No route to host|Network is unreachable|Host is down/i.test(stderr)
  ) {
    return 'unreachable'
  }
  return 'failed'
}

/**
 * The far side's own exit codes from the upload body (`buildUploadBody`), in
 * a sentence. 255 and anything unknown are ssh's, and get its own line.
 */
export function uploadExitMessage(code: number | null): string | null {
  switch (code) {
    case 3:
      return 'Stoke could not make a folder for it there (tried ~/.cache/stoke/paste and the temp folder).'
    case 4:
      return 'Writing the file there failed.'
    case 5:
      return 'The image arrived incomplete, so it was not kept.'
    case 6:
      return 'The finished file could not be put in place.'
    default:
      return null
  }
}
