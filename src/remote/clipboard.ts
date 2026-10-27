/*
 * Writing the phone's (or the laptop browser's) clipboard.
 *
 * `navigator.clipboard` exists only in a secure context, and the phone's LAN
 * and Tailscale links are plain http (`connectTarget`), so on the default link
 * it is undefined. `navigator.clipboard?.writeText(text).then(ok, fail)`
 * short-circuited as a whole there: no copy and neither toast, so Copy screen
 * did nothing and said nothing. `document.execCommand('copy')` over a hidden
 * textarea works without a secure context, inside a press.
 *
 * No `@shared` alias and no DOM at module scope: verify:phone-ui loads this
 * file under node's strip-types mode with a fake environment.
 */

/** What a copy did: written, refused because there was nothing to copy, or failed. */
export type CopyOutcome = 'copied' | 'empty' | 'failed'

/** The two ways a page can write the clipboard, injectable for the suite. */
export interface CopyEnv {
  /** `navigator.clipboard.writeText`, absent outside a secure context. */
  writeText?: (text: string) => Promise<void>
  /** The fallback; true when the browser says it copied. Needs a press in progress. */
  execCopy: (text: string) => boolean
}

/** This page's own clipboard routes. */
export function browserCopyEnv(): CopyEnv {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  return {
    writeText: clip && typeof clip.writeText === 'function' ? (text) => clip.writeText(text) : undefined,
    execCopy: execCommandCopy
  }
}

/**
 * Copy `text`, from inside a press. Empty text is refused before anything is
 * written, so copying nothing never erases the clipboard. With no
 * `writeText` the fallback runs at once, before any await, while the press
 * still counts as a user gesture; a `writeText` that rejects falls back too.
 */
export async function copyText(text: string, env: CopyEnv = browserCopyEnv()): Promise<CopyOutcome> {
  if (!text) return 'empty'
  if (!env.writeText) return env.execCopy(text) ? 'copied' : 'failed'
  try {
    await env.writeText(text)
    return 'copied'
  } catch {
    return env.execCopy(text) ? 'copied' : 'failed'
  }
}

/**
 * What to say when a copy failed. The https link is named only where this
 * page is plain http (`window.isSecureContext` false): on https, writeText was
 * refused and so was the fallback, and "try the https link" would be a
 * diagnosis the page itself disproves.
 */
export function copyFailedSentence(secure: boolean): string {
  return secure ? 'This browser would not copy.' : 'This browser would not copy on a plain http link. Try the https link.'
}

/**
 * The secure-context-free copy: a readonly textarea (no soft keyboard),
 * selected, `execCommand('copy')`, removed, and the focus put back where it
 * was. Styled by `.clipboard-buffer` (16px text, or iOS zooms on focus).
 */
export function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.className = 'clipboard-buffer'
  area.value = text
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.tabIndex = -1
  document.body.append(area)
  let ok = false
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  previous?.focus({ preventScroll: true })
  return ok
}
