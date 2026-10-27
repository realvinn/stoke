import type { ClipboardPeek } from '../shared/api.ts'

/**
 * The synchronous clipboard peek, from TYPES only.
 *
 * The renderer asks for this with `sendSync` on every paste chord and every
 * right-click (`clipboard.readSync`), so the window waits for the whole answer,
 * and a busy main process freezes it for as long as main takes. The peek used
 * to decide `hasImage` with `!clipboard.readImage().isEmpty()`, which DECODES
 * the image: Chromium reads the PNG (or builds an NSImage and re-encodes it to
 * PNG on the thread pool while main waits in a nested run loop), and Electron
 * then decodes that PNG into a bitmap, all on main. A Retina screenshot on the
 * clipboard made every right-click pay for it. Nothing here reads image bytes:
 * `availableFormats()` and `has()` are type tests (`NSPasteboard.types`,
 * `IsClipboardFormatAvailable`, the selection owner's TARGETS).
 *
 * What Chromium names, read from its source (ui/base/clipboard, the
 * `GetStandardFormats` of each platform):
 *
 *  - **`image/png`** when an image could be read: macOS when the pasteboard
 *    holds `public.png`/`public.tiff` or anything `NSImage` can init from,
 *    Windows when `CF_DIB` is there, Linux when the owner offers `image/png`
 *    (the only image `readImage` reads there).
 *  - **`text/uri-list`** when files were copied: macOS `public.file-url`,
 *    Windows `CF_HDROP`/`FileNameW`/`FileName`, Linux `text/uri-list`.
 *
 * Two gaps against what `readImage` and `clipboardFiles` read, each closed by a
 * raw `has()` so the peek's answer does not move:
 *
 *  - **macOS hides the image when files are there** ("Finder Cmd+C places both
 *    file and icon onto the clipboard", crbug.com/553686), but `readImage`
 *    decoded that icon, so the old peek said `hasImage` for every Finder copy —
 *    and bare Ctrl+V on a local tab counts a draft only for `xterm-image`
 *    (gotcha 82). With files present, any raw image type keeps it true.
 *  - **Windows reads a registered `PNG` before `CF_DIB`**, and the standard list
 *    names only `CF_DIB`; `clipboardFiles` reads `NSFilenamesPboardType` on
 *    macOS and GNOME's `x-special/gnome-copied-files` on Linux, which the
 *    standard list may not name.
 *
 * Pure (the clipboard is handed in), so `verify:freeze` holds the rule with a
 * fake one; `readClipboardPeek` (sshImages.ts) hands it Electron's.
 */

/** The slice of Electron's `clipboard` the peek may touch: text and type tests, never image data. */
export interface ClipboardTypes {
  readText(): string
  availableFormats(): string[]
  has(format: string): boolean
}

/** Chromium's standard names, the same on every platform (`kMimeTypePng`, `kMimeTypeUriList`). */
export const IMAGE_FORMAT = 'image/png'
export const FILES_FORMAT = 'text/uri-list'

/** Raw formats `readImage` reads that the standard list does not name. */
const RAW_IMAGE_FORMATS: Record<string, readonly string[]> = {
  win32: ['PNG']
}
/** Raw image types beside copied files on macOS (Finder's icon), which the standard list hides. */
const MAC_IMAGE_BESIDE_FILES = ['com.apple.icns', 'public.tiff', 'public.png'] as const
/** Raw formats `clipboardFiles` reads that the standard list may not name. */
const RAW_FILE_FORMATS: Record<string, readonly string[]> = {
  darwin: ['NSFilenamesPboardType'],
  linux: ['x-special/gnome-copied-files']
}

/**
 * Whether an image and files are on the clipboard, from the standard list and
 * at most a few raw type tests. `files` only says whether `clipboardFiles` is
 * worth calling: the count is its, and on a plain-text paste it is never asked.
 */
export function clipboardKinds(
  platform: string,
  formats: readonly string[],
  has: (format: string) => boolean
): { image: boolean; files: boolean } {
  const files = formats.includes(FILES_FORMAT) || (RAW_FILE_FORMATS[platform] ?? []).some(has)
  let image = formats.includes(IMAGE_FORMAT) || (RAW_IMAGE_FORMATS[platform] ?? []).some(has)
  if (!image && files && platform === 'darwin') image = MAC_IMAGE_BESIDE_FILES.some(has)
  return { image, files }
}

/**
 * The peek itself. `countFiles` is `clipboardFiles().count`, called only when a
 * file type is on the clipboard; the paths are read again, on demand, by
 * `CH.clipboardFilePaths` and the SSH upload.
 */
export function peekClipboard(clip: ClipboardTypes, platform: string, countFiles: () => number): ClipboardPeek {
  const text = clip.readText()
  let kinds = { image: false, files: true }
  try {
    kinds = clipboardKinds(platform, clip.availableFormats(), (f) => clip.has(f))
  } catch {
    /* no type list: no image claimed, and the file read decides on its own */
  }
  return { text, hasImage: kinds.image, files: kinds.files ? countFiles() : 0 }
}
