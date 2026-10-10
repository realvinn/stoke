/** Native input interception also covers the embedded browser's separate WebContents. */
export function windowShortcut(input: { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean; isAutoRepeat?: boolean; isComposing?: boolean }, isMac: boolean, count: number): -1 | 1 | null {
  if (count < 2 || input.type !== 'keyDown' || input.shift || input.alt || input.isAutoRepeat || input.isComposing) return null
  if (!(isMac ? input.meta && !input.control : input.control && !input.meta)) return null
  return input.key === 'ArrowLeft' ? -1 : input.key === 'ArrowRight' ? 1 : null
}

export function nextWindow<T>(windows: readonly T[], current: T, delta: -1 | 1): T | null {
  const index = windows.indexOf(current)
  return windows.length > 1 && index >= 0 ? windows[(index + delta + windows.length) % windows.length] : null
}
