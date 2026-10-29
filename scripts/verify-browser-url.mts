/*
 * What the docked browser will and will not load.
 *
 * Two separate things are asserted here and they fail in opposite directions.
 *
 * The first is a *capability boundary*. `browser_read` renders whatever is
 * loaded into text for the model, so whatever `browser_open` accepts is what an
 * agent can read off this machine. `normalizeUrl` used to return any
 * scheme-shaped input untouched — `if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return
 * raw` — which made `file:///Users/you/.ssh/id_rsa` a complete exfiltration path
 * with no prompt anywhere along it. The address bar keeps `file://` because the
 * actor there is a person who typed the path; no tool call does.
 *
 * The second is the ordinary case that the first one broke on the way past.
 * `localhost:3000` MATCHES the scheme shape, so it was returned verbatim and
 * Chromium was handed a URL whose scheme was `localhost`. It failed inside
 * `loadURL`'s own swallowed `.catch`, so the single most common development
 * address in the world did nothing and said nothing. A security fix that
 * silently breaks a daily workflow is not a fix, which is why both halves are
 * in one suite.
 *
 *   node scripts/verify-browser-url.mts
 */
import { readFileSync } from 'node:fs'
import { browserPopupUrl, normalizeUrl, refusedScheme } from '../src/shared/url.ts'
import { contextMenuTemplate, openableLink, type MenuEntry, type MenuParams } from '../src/main/contextMenu.ts'
import { overlongPaste, pastedLength, refuseOverlongPaste } from '../src/renderer/src/lib/pasteLimit.ts'
import { browserPopupChecks } from './browser-popup-checks.mts'

const BAR = { allowLocalFiles: true }

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/** A search is the refusal: it is what the address bar does with what it cannot open. */
const searched = (raw: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`

console.log('\nthe schemes an agent may open')
check('http passes', normalizeUrl('http://example.com/x'), 'http://example.com/x')
check('https passes', normalizeUrl('https://example.com/x'), 'https://example.com/x')
check('about: passes, because that is where a blank tab starts', normalizeUrl('about:blank'), 'about:blank')
check(
  'file:// does NOT — this is the whole point of the suite',
  normalizeUrl('file:///Users/you/.ssh/id_rsa'),
  searched('file:///Users/you/.ssh/id_rsa')
)
check('nor does a file:// with no host', normalizeUrl('file:/etc/passwd'), searched('file:/etc/passwd'))
check('javascript: never, on any path', normalizeUrl('javascript:alert(1)'), searched('javascript:alert(1)'))
check('data: never either', normalizeUrl('data:text/html,<h1>x'), searched('data:text/html,<h1>x'))
check('chrome:// is not the agent’s business', normalizeUrl('chrome://settings'), searched('chrome://settings'))
check('nor is devtools://', normalizeUrl('devtools://devtools/x'), searched('devtools://devtools/x'))
check('mailto: would hand the page to another app', normalizeUrl('mailto:a@b.c'), searched('mailto:a@b.c'))
check('FILE:// in capitals is the same scheme', normalizeUrl('FILE:///etc/passwd'), searched('FILE:///etc/passwd'))
check(
  'and so is a leading space, because the scheme is read after a trim',
  normalizeUrl('  file:///etc/passwd'),
  searched('file:///etc/passwd')
)

console.log('\nthe address bar, where the actor is a person who typed it')
check('file:// is allowed back in, and only here', normalizeUrl('file:///Users/me/dist/index.html', BAR), 'file:///Users/me/dist/index.html')
check('javascript: is still refused, because nobody ever means it', normalizeUrl('javascript:alert(1)', BAR), searched('javascript:alert(1)'))
check('data: likewise', normalizeUrl('data:text/html,<h1>x', BAR), searched('data:text/html,<h1>x'))

console.log('\nrefusedScheme names the scheme, so the model is told why')
check('the refused scheme comes back by name', refusedScheme('file:///etc/passwd'), 'file')
check('the address bar refuses nothing about file://', refusedScheme('file:///etc/passwd', BAR), null)
check('an allowed scheme is not a refusal', refusedScheme('https://example.com'), null)
check('a bare hostname has no scheme to refuse', refusedScheme('example.com'), null)
check('and neither does free text', refusedScheme('how tall is everest'), null)

console.log('\nhost:port is scheme-shaped and is not a scheme')
check('localhost:3000 — the case the scheme test used to eat', normalizeUrl('localhost:3000'), 'http://localhost:3000')
check('with a path', normalizeUrl('localhost:5173/app'), 'http://localhost:5173/app')
check('bare localhost still works', normalizeUrl('localhost'), 'http://localhost')
check('localhost is never reported as a refused scheme', refusedScheme('localhost:3000'), null)
check('an IPv4 host and port is unaffected', normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080')
check('a LAN address too', normalizeUrl('192.168.1.10:8000/x'), 'http://192.168.1.10:8000/x')

console.log('\neverything else the address bar has always done')
check('a bare hostname becomes https', normalizeUrl('example.com'), 'https://example.com')
check('a hostname with a path', normalizeUrl('example.com/a/b'), 'https://example.com/a/b')
check('free text is searched', normalizeUrl('how tall is everest'), searched('how tall is everest'))
check('empty is a blank tab, not a search for nothing', normalizeUrl(''), 'about:blank')
check('whitespace only is also a blank tab', normalizeUrl('   '), 'about:blank')

check('browser popups accept web documents, their blobs and a script-owned blank window', ['https://example.com', 'http://localhost:3000', 'about:blank', 'about:blank#popup', 'blob:https://example.com/id'].map(browserPopupUrl), [true, true, true, true, true])
check('browser popups do not gain local-file or privileged scheme navigation', ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'about:config', 'blob:file:///etc/passwd'].map(browserPopupUrl), [false, false, false, false, false, false])
await browserPopupChecks(check)

/*
 * Copy and paste outside the terminal: the right-click menu (src/main/contextMenu.ts),
 * a docked page's clipboard permission, copy buttons a selection must not pick
 * up, and a paste a field's maxLength would cut. Here because they are the
 * browser's and the fields' half of the 2026-10-27 copy/paste audit.
 */
const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canEditRichly: false }
const params = (p: Partial<MenuParams> & { editFlags?: Partial<MenuParams['editFlags']> } = {}): MenuParams => ({
  isEditable: false, selectionText: '', linkURL: '', srcURL: '', mediaType: 'none', hasImageContents: false,
  ...p, editFlags: { ...NO_EDIT, ...p.editFlags }
})
const APP = { dev: false, canOpenTab: false }
const PAGE = { dev: false, canOpenTab: true }
/** A template as `command[:off]`, `action` and `-`, so a check reads as the menu does. */
const shape = (entries: MenuEntry[]): string[] => entries.map((e) =>
  e.type === 'separator' ? '-' : e.type === 'edit' ? `${e.command}${e.enabled ? '' : ':off'}` : e.action)
const separatorsTidy = (entries: MenuEntry[]): boolean => {
  const s = shape(entries).join(' ')
  return !s.startsWith('-') && !s.endsWith('-') && !s.includes('- -')
}

console.log('\nthe right-click menu')
const field = params({ isEditable: true, editFlags: { canUndo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } })
check('a text field gets Undo/Redo and Cut, Copy, Paste, Select All, each as its edit flags allow',
  shape(contextMenuTemplate(field, APP)), ['undo', 'redo:off', '-', 'cut', 'copy', 'paste', 'selectAll'])
check('Paste and Match Style only where there is a style to drop (a contenteditable)',
  shape(contextMenuTemplate(params({ isEditable: true, editFlags: { canPaste: true, canEditRichly: true } }), PAGE)),
  ['undo:off', 'redo:off', '-', 'cut:off', 'copy:off', 'paste', 'pasteAndMatchStyle', 'selectAll:off'])
check('a password field keeps Paste and loses Cut and Copy (Chromium says so in its flags)',
  shape(contextMenuTemplate(params({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } }), PAGE)).slice(3),
  ['cut:off', 'copy:off', 'paste', 'selectAll'])
check('a selection in the chat viewer gets Copy',
  shape(contextMenuTemplate(params({ selectionText: 'first message line' }), APP)), ['copy'])
check('a blank click, or a selection of nothing but spaces, gets no menu at all',
  [contextMenuTemplate(params(), APP).length, contextMenuTemplate(params({ selectionText: ' \n ' }), APP).length], [0, 0])
check('a page link opens in a new tab and copies its address',
  shape(contextMenuTemplate(params({ linkURL: 'https://example.com/docs' }), PAGE)), ['openLinkInNewTab', 'copyLink'])
check('a link in Stoke\'s own window copies its address only (no tabs of pages there)',
  shape(contextMenuTemplate(params({ linkURL: 'https://example.com/docs' }), APP)), ['copyLink'])
check('a page link to file:, javascript: or data: is never opened in a tab, only copied',
  ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x'].map((linkURL) => shape(contextMenuTemplate(params({ linkURL }), PAGE))),
  [['copyLink'], ['copyLink'], ['copyLink']])
check('openableLink is http(s) only', ['https://a.b', 'HTTP://a.b', 'file:///x', 'about:blank', 'blob:https://a.b/1'].map(openableLink),
  [true, true, false, false, false])
check('an image copies itself and its address',
  shape(contextMenuTemplate(params({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.com/a.png' }), PAGE)),
  ['copyImage', 'copyImageAddress'])
const linkedImage = contextMenuTemplate(params({ linkURL: 'https://example.com/', mediaType: 'image', hasImageContents: true, srcURL: 'https://example.com/a.png' }), PAGE)
check('a linked image gets both groups, one separator between them',
  shape(linkedImage), ['openLinkInNewTab', 'copyLink', '-', 'copyImage', 'copyImageAddress'])
check('Inspect Element only in dev, last, after a separator',
  [shape(contextMenuTemplate(field, { dev: true, canOpenTab: false })).slice(-2), shape(contextMenuTemplate(params(), { dev: true, canOpenTab: false }))],
  [['-', 'inspect'], ['inspect']])
check('no menu starts, ends or doubles a separator',
  [field, params({ selectionText: 'x', linkURL: 'https://a.b' }), params({ mediaType: 'image', srcURL: 'x' }), params({ mediaType: 'image' })]
    .flatMap((p) => [contextMenuTemplate(p, PAGE), contextMenuTemplate(p, { dev: true, canOpenTab: true })]).every(separatorsTidy), true)
const wiring = source('src/main/index.ts')
check('Stoke\'s main, detached and quick-terminal windows each get the menu',
  (wiring.match(/attachContextMenu\((win|popup)\.webContents, \{ Menu, clipboard \}/g) ?? []).length, 3)
// The native menu never opens over a terminal only because each terminal host
// cancels its DOM contextmenu (Chromium raises `context-menu` for an uncancelled
// one alone); without that its Paste reaches xterm's helper textarea. Each
// cancel is the handler's first statement, registered in the capture phase.
const terminalView = source('src/renderer/src/components/TerminalView.tsx')
const quickTerminal = source('src/renderer/src/components/QuickTerminal.tsx')
const terminalSelection = source('src/renderer/src/lib/terminalSelection.ts')
const remoteTerminal = source('src/renderer/src/components/RemoteTerminal.tsx')
check('every terminal host cancels its contextmenu first, in the capture phase, so the native menu never opens there',
  [/const onContextMenu = \(e: MouseEvent\): void => \{\s*e\.preventDefault\(\)/.test(terminalView),
    /host\.addEventListener\('contextmenu', onContextMenu, true\)/.test(terminalView),
    /const context = \(event: MouseEvent\): void => \{\s*event\.preventDefault\(\)/.test(quickTerminal),
    /node\.addEventListener\('contextmenu', context, true\)/.test(quickTerminal),
    /const context = \(event: MouseEvent\): void => \{\s*if \(!menu\) return\s*event\.preventDefault\(\)/.test(terminalSelection),
    /host\.addEventListener\('contextmenu', context, true\)/.test(terminalSelection),
    // installTerminalClipboard cancels only when handed a menu: the hub remote tab must pass one.
    /installTerminalClipboard\(host, term, \{[\s\S]*?\n\s*menu: /.test(remoteTerminal)],
  [true, true, true, true, true, true, true])
// A docked tab's menu is driven through the real EmbeddedBrowser in browser-popup-checks.mts.

console.log('\nwhat a docked page may do with the clipboard')
const browserSource = source('src/main/browser.ts')
const harmless = /const HARMLESS_PERMISSIONS = new Set\(\[([^\]]*)\]\)/.exec(browserSource)?.[1] ?? ''
const granted = [...harmless.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
check('a page may write the clipboard (its Copy buttons), and nothing else was added',
  granted, ['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
check('it may never read it', granted.filter((p) => /read/.test(p)), [])
check('both permission handlers answer from that one list',
  [/setPermissionRequestHandler\(\(_wc, permission, callback\) => callback\(allow\(permission\)\)\)/.test(browserSource),
    /setPermissionCheckHandler\(\(_wc, permission\) => allow\(permission\)\)/.test(browserSource),
    /const allow = \(permission: string\): boolean => HARMLESS_PERMISSIONS\.has\(permission\)/.test(browserSource)],
  [true, true, true])

console.log('\ncopy buttons a selection must not copy')
const viewer = source('src/renderer/src/components/ChatViewer.tsx')
const grok = source('src/renderer/src/components/GrokBotMessages.tsx')
const css = source('src/renderer/src/styles/app.css')
// Measured in headless Chromium: a selection over two messages copied the
// button's sr-only text, or the Grok button's "Copy", between them.
check('the chat viewer\'s copy button is named by aria-label, with no text inside to copy',
  [/className="icon-btn chat-msg-copy"[\s\S]{0,200}aria-label="Copy this message"/.test(viewer), /<span className="sr-only">Copy this message<\/span>/.test(viewer)], [true, false])
check('the Grok message button carries the unselectable class', /className="btn grok-message-copy"/.test(grok), true)
const unselectable = /\.chat-msg-copy,\s*\.grok-message-copy\s*\{[^}]*(?<!-webkit-)user-select:\s*none/.exec(css)
check('both buttons are user-select: none', !!unselectable, true)

console.log('\na paste longer than a field holds')
const box = (value: string, maxLength: number, multiline = true, sel?: [number, number]) =>
  ({ value, maxLength, multiline, selectionStart: sel ? sel[0] : value.length, selectionEnd: sel ? sel[1] : value.length })
check('a paste that fits goes through', overlongPaste(box('hi ', 32 * 1024), 'x'.repeat(1000)), null)
check('a paste that lands exactly on the limit fits (Blink cuts only past it)', overlongPaste(box('ab', 10), 'x'.repeat(8)), null)
check('the Grok composer refuses a 40,000-character log, naming the limit',
  overlongPaste(box('', 32 * 1024), 'x'.repeat(40_000)),
  'Not pasted: that is 40,000 characters, and this box holds 32,768. Your clipboard still has it.')
check('with text already there it says how much room is left',
  overlongPaste(box('abcd', 10), 'x'.repeat(7)), 'Not pasted: that is 7 characters, and this box has room for 6 more of its 10. Your clipboard still has it.')
check('a selection the paste replaces is room too', [overlongPaste(box('abcdef', 10, true, [2, 4]), 'x'.repeat(6)), !!overlongPaste(box('abcdef', 10, true, [2, 4]), 'x'.repeat(7))], [null, true])
check('a full box says so', overlongPaste(box('x'.repeat(10), 10), 'y'), 'Not pasted: that is 1 character, and this box is full (10). Your clipboard still has it.')
check('no maxLength (-1 or 0) is no limit', [overlongPaste(box('', -1), 'x'.repeat(5)), overlongPaste(box('', 0), 'x')], [null, null])
check('CRLF counts once in a textarea, as Blink inserts it',
  [pastedLength('a\r\nb\rc\n', true), overlongPaste(box('', 6), 'a\r\nb\r\nc'), !!overlongPaste(box('', 4), 'a\r\nb\r\nc')], [6, null, true])
check('a single-line input drops trailing breaks and makes the others one space',
  [pastedLength('one\r\ntwo\nthree\r\n', false), pastedLength('one\r\ntwo\nthree\r\n', true)], [13, 14])
const pasteEvent = (tagName: string, value: string, maxLength: number, text: string) => {
  const event = { prevented: false, currentTarget: { tagName, value, maxLength, selectionStart: value.length, selectionEnd: value.length },
    clipboardData: { getData: (format: string) => format === 'text/plain' ? text : '' }, preventDefault() { event.prevented = true } }
  return event
}
const over = pasteEvent('TEXTAREA', '', 5, 'abcdef'), under = pasteEvent('TEXTAREA', '', 5, 'abc'), image = pasteEvent('TEXTAREA', 'abcde', 5, '')
check('the handler cancels only a paste that would be cut, and an image paste is left alone',
  [!!refuseOverlongPaste(over), over.prevented, refuseOverlongPaste(under), under.prevented, refuseOverlongPaste(image), image.prevented],
  [true, true, null, false, null, false])
check('an <input> is measured single-line', refuseOverlongPaste(pasteEvent('INPUT', '', 5, 'abcde\r\n')), null)
// Every maxLength in the composers the audit named has the guard on the same
// tag, and its note is its own: not the panel's shared error or the draft
// cache's status (which a save, blur or storage event rewrites), and cleared by
// that same field's next edit, so it never outlives the paste it was about.
const CLEARED_ON_EDIT: Record<string, RegExp> = {
  GrokBotWorkspace: /onChange=\{event => onChange\(\{[^}]*sendError: ''/,
  WorkPanel: /onChange=\{typed\(set[A-Z]\w*\)\}/,
  WorkDrafts: /onChange=\{\(e\) => \{ setPasteNote\(''\); /
}
for (const [file, cleared] of Object.entries(CLEARED_ON_EDIT)) {
  const text = source(`src/renderer/src/components/${file}.tsx`)
  const tags = text.split('maxLength={').slice(1).map((after, i) => {
    const before = text.split('maxLength={').slice(0, i + 1).join('maxLength={')
    const open = Math.max(before.lastIndexOf('<textarea'), before.lastIndexOf('<input'))
    return before.slice(open) + after.slice(0, after.indexOf('/>'))
  })
  check(`${file}: every field with a maxLength refuses an overlong paste`, tags.length > 0 && tags.every((tag) => /onPaste=/.test(tag)), true)
  // What each `refuseOverlongPaste` call does with a refusal, inline or in a named guard.
  const pasteHandlers = [...text.matchAll(/refuseOverlongPaste\(\w+\); if \(\w+\) ([^\n]*?) \}/g)].map((m) => m[1])
  check(`${file}: the paste note is its own and goes with the field's next edit`,
    [tags.every((tag) => cleared.test(tag)), pasteHandlers.length > 0 && pasteHandlers.every((h) => !/setError\(|setNote\(/.test(h))], [true, true])
}
check('WorkPanel: `typed` clears the paste note before it sets the field',
  /const typed = [^\n]*=> \{ setPasteNote\(''\); set\(e\.target\.value\) \}/.test(source('src/renderer/src/components/WorkPanel.tsx')), true)

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
