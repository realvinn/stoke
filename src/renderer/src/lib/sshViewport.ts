import type { TerminalViewport } from '../../../shared/terminalViewport.ts'

/** A reconnect replaces a PTY (and its React component), but the managed
 * shell keeps its identity. Keep a bounded, in-memory bookmark across that
 * replacement; never persist terminal content or mix it with another host.
 */
const bookmarks = new Map<string, TerminalViewport>()
export function rememberSshViewport(key: string, viewport: TerminalViewport): void {
  bookmarks.delete(key)
  bookmarks.set(key, viewport)
  while (bookmarks.size > 50) bookmarks.delete(bookmarks.keys().next().value!)
}
export function takeSshViewport(key: string): TerminalViewport | undefined {
  const saved = bookmarks.get(key)
  bookmarks.delete(key)
  return saved
}
