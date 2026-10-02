/**
 * Images and files into an SSH session: the rules both processes need.
 *
 * A pasted or dropped image cannot reach a `claude` on another machine through
 * the terminal — there is no image protocol on a pty, and the far side cannot
 * read this machine's clipboard. So Stoke copies the bytes there over a second,
 * BatchMode ssh connection (`buildUploadArgs`, ssh.ts; `sendUpload`,
 * sshUpload.ts) and types the far path, which Claude Code attaches the way it
 * attaches any image path in a paste. Any other file dropped (or copied in
 * Finder/Explorer and pasted) goes the same way and keeps its own name: the
 * typed path is then something the far `claude` can read (gotcha 152).
 *
 * Everything that becomes part of a remote command is decided in main: the
 * name (an image's extension from its bytes, a file's from its own name, both
 * through one whitelist) and the size. The renderer sends a host id and either
 * "the clipboard", bytes, or a dropped File whose path only the preload reads
 * (`webUtils.getPathForFile`); main never uses a name as it was given.
 *
 * Pure and dependency-free (gotcha 27: compiled by both projects; gotcha 78:
 * imported by suites by relative path).
 */

/**
 * The largest image Stoke sends. Claude Code downsizes what it attaches anyway
 * (to roughly 3.75 MB raw), so anything bigger is only a longer wait on a slow
 * link. Past this an image with a file on this computer is sent as the FILE it
 * is (name kept, `MAX_FILE_BYTES`); one with none (the clipboard, a drag out
 * of a browser) is refused with a sentence.
 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * The largest FILE Stoke sends (anything that is not an image, and an image
 * past `MAX_IMAGE_BYTES`, which then goes as the file it is). A second ssh is
 * not a file manager: past this, `scp` or `rsync` in a terminal is the tool,
 * and a sentence says so rather than a long wait that fails.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024

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

/** Any name Stoke may write on another machine, an image's or a file's: what `buildUploadBody` takes. */
export function isSafeFarName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_UPLOAD_NAME.test(name)
}

/** An IMAGE's name: a safe name ending in the extension its bytes gave it. */
export function isSafeUploadName(name: unknown): name is string {
  return isSafeFarName(name) && /\.(png|jpg|gif|webp)$/.test(name)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * `pasted-image-20261002-143005-a1b2c3.png`: local time, so it sorts and reads
 * the way the user remembers pasting, plus six hex digits so two pastes in one
 * second do not meet. `hex` comes from main's random bytes.
 */
export function clipboardImageName(now: Date, hex: string, kind: ImageKind = 'png'): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-image-${stamp}-${hex6(hex)}.${kind}`
}

/** Main's random hex, at most six digits of it. */
function hex6(hex: string): string {
  return hex.replace(/[^0-9a-f]/g, '').slice(0, 6)
}

/** The last part of a path, by either separator: a File's name has none, a path from the clipboard does. */
function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? ''
}

/**
 * A stem cut down to the safe alphabet: anything else becomes `-`, runs
 * collapse, at most 48 characters, and only a letter or digit at its start.
 * (An `_` used to survive there, so `_x.png` failed `isSafeUploadName` and
 * was refused as "could not name that image safely".) `fallback` when nothing
 * is left.
 */
function safeStem(stem: string, fallback: string): string {
  const cut = stem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
    .replace(/[.-]+$/, '')
  return cut || fallback
}

/**
 * A dropped image's name, kept recognisable: its stem through `safeStem`,
 * then six hex digits and the extension its BYTES say.
 * `Screenshot 2026-10-02 at 2.30.05 pm.png` becomes
 * `Screenshot-2026-10-02-at-2.30.05-pm-a1b2c3.png`.
 */
export function droppedImageName(fileName: string, hex: string, kind: ImageKind): string {
  const base = baseName(fileName)
  const dot = base.lastIndexOf('.')
  return `${safeStem(dot > 0 ? base.slice(0, dot) : base, 'image')}-${hex6(hex)}.${kind}`
}

/**
 * The extension a file keeps: its last `.part` when that is 1–12 letters and
 * digits, with a `.tar` in front of it kept too (`.tar.gz` is one extension
 * to every tool that reads it). Anything else is dropped rather than cut, so
 * `notes.日本` keeps no extension, never a mangled one.
 */
const FILE_EXT = /^(.+?)((?:\.tar)?\.[A-Za-z0-9]{1,12})$/i

/**
 * A dropped or pasted FILE's name on the far machine: the user's own name and
 * extension through the same whitelist as an image's, plus six hex digits
 * before the extension so two drops of `notes.txt` never meet.
 * `My Report (final).pdf` becomes `My-Report-final-a1b2c3.pdf`,
 * `archive.tar.gz` `archive-a1b2c3.tar.gz`, `.env` `env-a1b2c3`, and a name
 * with nothing safe in it `file-a1b2c3` with its extension kept when that is
 * safe (`日本語.pdf` is `file-a1b2c3.pdf`). Always passes `isSafeFarName`.
 */
export function droppedFileName(fileName: string, hex: string): string {
  const base = baseName(fileName)
  const m = FILE_EXT.exec(base)
  // A dot-file (`.env`) is all stem: its "extension" is its name.
  const split = m && !/^\.*$/.test(m[1]) ? { stem: m[1], ext: m[2] } : { stem: base, ext: '' }
  return `${safeStem(split.stem, 'file')}-${hex6(hex)}${split.ext}`
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
 * Why `label` is not sent: its size and the cap, in a sentence. A size just
 * past a cap rounds to the cap's own figure, and "huge.bin is 100.0 MB; Stoke
 * sends files up to 100.0 MB" (what a 100 MB + 1 byte drop said in the app)
 * reads as a contradiction, so that size is said as "over" the cap.
 */
export function tooLargeSentence(label: string, size: number, cap: number, noun: UploadNoun): string {
  const was = formatBytes(size)
  const most = formatBytes(cap)
  return `${label} is ${was === most ? `over ${most}` : was}; Stoke sends ${noun}s up to ${most}.`
}

/**
 * How long one send may take before it is given up: 15 s to connect and
 * settle, plus the bytes at 150 KB/s (a poor uplink), at most two minutes.
 */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(120_000, 15_000 + Math.ceil(bytes / (150 * 1024)) * 1000)
}

/**
 * A FILE's limits, which an image's two minutes cannot be: 100 MB at a poor
 * uplink's 150 KB/s is eleven minutes. So the whole send may take 15 s plus
 * the bytes at 25 KB/s (at most 30 minutes), and it is given up sooner if ssh
 * stops TAKING bytes for `UPLOAD_IDLE_MS` while there are bytes left to give
 * it: a stalled link says so in a minute rather than half an hour. The strip
 * shows the progress meanwhile, and Cancel is always there.
 */
export function fileUploadTimeoutMs(bytes: number): number {
  return Math.min(30 * 60_000, 15_000 + Math.ceil(bytes / (25 * 1024)) * 1000)
}

export const UPLOAD_IDLE_MS = 60_000

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
export function uploadExitMessage(code: number | null, noun: UploadNoun = 'image'): string | null {
  switch (code) {
    case 3:
      return 'Stoke could not make a folder for it there (tried ~/.cache/stoke/paste and the temp folder).'
    case 4:
      return 'Writing the file there failed.'
    case 5:
      return `The ${noun} arrived incomplete, so it was not kept.`
    case 6:
      return 'The finished file could not be put in place.'
    default:
      return null
  }
}

/** What the sentences call the thing being sent. */
export type UploadNoun = 'image' | 'file'

/* ------------------------------------------- files copied in Finder or Explorer */

/*
 * A file copied in the file manager and pasted with Cmd/Ctrl+V on an SSH tab.
 * Main reads the paths off the clipboard itself, as it reads a pasted image, so
 * nothing the renderer says becomes a path. What each platform puts there, and
 * what Electron can read of it:
 *
 * - **macOS**: one `public.file-url` item per file. `clipboard.read` of that
 *   type answers only the FIRST item (measured: two copied, one read), but the
 *   legacy `NSFilenamesPboardType`, which AppKit still synthesises from them,
 *   is a plist listing every one (`parseFilenamesPlist`). Measured on macOS 27.
 * - **Linux**: `text/uri-list` (`parseUriList`), which GNOME Files and Dolphin
 *   both offer. Not run on Linux.
 * - **Windows**: Explorer's `CF_HDROP` is a standard format Electron cannot
 *   name, so only `FileNameW` (the FIRST file, UTF-16) is readable; the count
 *   comes from `Shell IDList Array` (a CIDA, whose first UINT is the number of
 *   items), and several copied files are refused with a sentence rather than
 *   one of them sent without a word. Not run on Windows.
 */

/** XML's five entities and numeric references, which a plist `<string>` may hold. */
function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

/** Absolute POSIX paths out of `NSFilenamesPboardType`'s plist, in order. */
export function parseFilenamesPlist(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const p = xmlText(m[1])
    if (p.startsWith('/') && !p.includes('\u0000')) out.push(p)
  }
  return out
}

/**
 * The local path a `file:` URL names, or null. Only `file:///…` and
 * `file://localhost/…`: a URL naming another host is not a file here.
 */
export function fileUrlPath(url: string): string | null {
  const m = /^file:\/\/(localhost)?(\/[^?#]*)$/i.exec(url.trim())
  if (!m) return null
  try {
    const p = decodeURIComponent(m[2])
    return p.includes('\u0000') ? null : p
  } catch {
    return null
  }
}

/** Paths out of a `text/uri-list` (RFC 2483: CRLF lines, `#` comments), `file:` URLs only. */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(fileUrlPath)
    .filter((p): p is string => p !== null)
}

/** `FileNameW`'s one path: UTF-16LE up to the first NUL. */
export function fileNameW(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

/** How many items a CIDA (`Shell IDList Array`) holds: its first UINT, little-endian; 0 when absent. */
export function cidaCount(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0
  return bytes[0] + bytes[1] * 0x100 + bytes[2] * 0x10000 + bytes[3] * 0x1000000
}
