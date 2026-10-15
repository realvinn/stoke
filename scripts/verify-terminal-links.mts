/** The real xterm buffer: soft wraps, CRLF and CUP repaints, both screens,
 * grapheme widths and resize/reflow. No renderer or user session is borrowed. */
import headless from '@xterm/headless'
import { UnicodeGraphemesAddon } from '../node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs'
import { terminalHttpLink, terminalLinkRepairs, selectedTerminalLink, terminalLinkClick } from '../src/shared/terminalLinks.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n    got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const url = 'https://example.com/project/deep/path?code=abcdefghijklmnopqrstuvwxyz'
const write = (term: headless.Terminal, value: string): Promise<void> => new Promise((resolve) => term.write(value, resolve))
const wrap = (value: string, width: number, separator: (row: number) => string): string => {
  const rows: string[] = []
  for (let at = 0; at < value.length; at += width) rows.push((at ? separator(rows.length + 1) : '') + value.slice(at, at + width))
  return rows.join('')
}
for (const screen of ['normal', 'alternate']) {
  for (const mode of ['soft', 'newline', 'cursor']) {
    const terminal = new headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true })
    try {
      if (screen === 'alternate') await write(terminal, '\x1b[?1049h')
      const value = mode === 'soft' ? url : wrap(url, 40, (row) => mode === 'newline' ? '\r\n' : `\x1b[${row};1H`)
      await write(terminal, value)
      const first = terminalLinkRepairs(terminal, 1)
      const tail = terminalLinkRepairs(terminal, 2)
      check(`${screen}/${mode}: either half activates one complete URL`, [first.map((l) => l.text), tail.map((l) => l.text)], [[url], [url]])
      check(`${screen}/${mode}: range covers both rows and every clickable cell`, first[0]?.range, { start: { x: 1, y: 1 }, end: { x: url.length - 40, y: 2 } })
    } finally { terminal.dispose() }
  }
}
{
  const terminal = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true })
  try {
    await write(terminal, 'https://example.com/short\r\nan unrelated line')
    check('a short line never borrows words from the next line', terminalLinkRepairs(terminal, 1), [])
    terminal.reset()
    await write(terminal, url.slice(0, 40) + '\r\n' + 'https://other.example/')
    check('a new URL beginning the next full row is kept separate', terminalLinkRepairs(terminal, 1), [])
    terminal.reset()
    await write(terminal, url.slice(0, 39) + ' ' + '\r\n' + url.slice(39))
    check('an actual printed trailing space remains a URL delimiter', terminalLinkRepairs(terminal, 1), [])
    terminal.reset()
    await write(terminal, url.slice(0, 39) + '\r\n' + url.slice(39))
    check('an unoccupied one-cell gutter preserves the complete URL from either row', [terminalLinkRepairs(terminal, 1)[0]?.text, terminalLinkRepairs(terminal, 2)[0]?.text], [url, url])
    check('a one-cell gutter maps the URL tail without including the empty cell', terminalLinkRepairs(terminal, 2)[0]?.range, { start: { x: 1, y: 1 }, end: { x: url.length - 39, y: 2 } })
    terminal.reset()
    await write(terminal, url.slice(0, 40) + '\r\n  ' + url.slice(40))
    check('a hanging indent after a full URL row preserves the complete address', terminalLinkRepairs(terminal, 1)[0]?.text, url)
    terminal.reset()
    const long = 'https://example.com/' + 'x'.repeat(120)
    await write(terminal, wrap(long, 40, () => '\r\n'))
    check('a URL repainted across four rows stays whole at its tail', terminalLinkRepairs(terminal, 4)[0]?.text, long)
    terminal.reset()
    await write(terminal, url.slice(0, 40) + '\r\n' + url.slice(40))
    terminal.resize(80, 12)
    check('a resize never invents a hard wrap inside the wider grid', terminalLinkRepairs(terminal, 1), [])
  } finally { terminal.dispose() }
}
for (const screen of ['normal', 'alternate']) {
  for (const mode of ['newline', 'cursor']) {
    for (const printedPadding of [false, true]) {
      const terminal = new headless.Terminal({ cols: 80, rows: 12, allowProposedApi: true })
      try {
        if (screen === 'alternate') await write(terminal, '\x1b[?1049h')
        const long = 'https://example.com/project?code=' + 'abcdefghijklmnopqrstuvwxyz'.repeat(7) + '&end=whole'
        const parts = long.match(/.{1,74}/g)!
        const value = parts.map((part, index) => (index ? mode === 'newline' ? '\r\n' : `\x1b[${index + 1};1H` : '') + '  ' + part + (printedPadding && index < parts.length - 1 ? '    ' : '')).join('')
        await write(terminal, value)
        const links = parts.map((_, index) => terminalLinkRepairs(terminal, index + 1)[0])
        check(`${screen}/${mode}/${printedPadding ? 'printed' : 'empty'} gutter: every padded row opens the whole URL`, links.map((link) => link?.text), parts.map(() => long))
        check(`${screen}/${mode}/${printedPadding ? 'printed' : 'empty'} gutter: clickable range excludes leading and final padding`, links[0]?.range, { start: { x: 3, y: 1 }, end: { x: 2 + parts.at(-1)!.length, y: parts.length } })
      } finally { terminal.dispose() }
    }
  }
}
{
  const terminal = new headless.Terminal({ cols: 80, rows: 80, allowProposedApi: true })
  try {
    const long = 'https://example.com/auth?state=' + 'x'.repeat(3500) + '&end=whole'
    await write(terminal, long)
    const lastRow = Math.ceil(long.length / terminal.cols)
    check('a soft-wrapped URL beyond the web addon 2 KiB window stays whole from either end', [terminalLinkRepairs(terminal, 1)[0]?.text, terminalLinkRepairs(terminal, lastRow)[0]?.text], [long, long])
    check('a long soft-wrapped link retains its exact final cell', terminalLinkRepairs(terminal, lastRow)[0]?.range.end, { x: long.length % terminal.cols, y: lastRow })
    terminal.reset()
    await write(terminal, '  https://example.com/short\r\n  unrelated')
    check('matching indentation does not join a genuinely short URL to a word', terminalLinkRepairs(terminal, 1), [])
    terminal.reset()
    const padded = '  ' + url + 'x'.repeat(74 - url.length)
    await write(terminal, padded + '\r\n  unrelated words')
    check('a full padded URL row does not borrow prose', terminalLinkRepairs(terminal, 1), [])
    terminal.reset()
    await write(terminal, padded + '\r\n  https://other.example/')
    check('a separate URL in the same padded column remains separate', terminalLinkRepairs(terminal, 1), [])
    terminal.reset()
    await write(terminal, padded + '\r\n    /different-indent')
    check('inconsistent content-column indentation is not guessed', terminalLinkRepairs(terminal, 1), [])
  } finally { terminal.dispose() }
}
{
  const terminal = new headless.Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  terminal.loadAddon(new UnicodeGraphemesAddon()); terminal.unicode.activeVersion = '15-graphemes'
  try {
    // Wide glyphs and a combined grapheme precede the URL. Its text indexes
    // differ from terminal cells; only cells determine the clickable range.
    const prefix = '界e\u0301 '
    await write(terminal, prefix + url.slice(0, 36) + '\r\n' + url.slice(36))
    const result = terminalLinkRepairs(terminal, 2)[0]
    check('wide/combining text before a URL maps to cells, not UTF-16 offsets', [result?.text, result?.range], [url, { start: { x: 5, y: 1 }, end: { x: url.length - 36, y: 2 } }])
    terminal.reset()
    const path = 'https://example.com/wiki/Function_(math)'
    await write(terminal, path.slice(0, 40) + '\r\n' + path.slice(40) + ').')
    // The path fits one row, so use a shorter grid to cross the boundary.
    terminal.reset(); terminal.resize(30, 10)
    await write(terminal, path.slice(0, 30) + '\r\n' + path.slice(30) + ').')
    check('balanced parentheses stay in a wrapped URL; surrounding punctuation does not', terminalLinkRepairs(terminal, 2)[0]?.text, path)
  } finally { terminal.dispose() }
}
check('selection repairs short/indented wraps only for one complete URL', [selectedTerminalLink(' https://example.com/long\n    /path?q=1 '), selectedTerminalLink('https://example.com/\nother words'), selectedTerminalLink('https://a.example/\nhttps://b.example/'), selectedTerminalLink('https://example.com\n\nnext')], ['https://example.com/long/path?q=1', null, null, null])
check('non-web schemes, controls and invalid ports cannot activate from terminal links', [terminalHttpLink('javascript:alert(1)'), terminalHttpLink('file:///etc/passwd'), terminalHttpLink('https://example.com/\nword'), terminalHttpLink('http://localhost:99999/'), terminalHttpLink('http://localhost:3000/a')], [null, null, null, null, 'http://localhost:3000/a'])
check('malformed or out-of-bounds buffer rows are refused', terminalLinkRepairs({ cols: 80, buffer: { active: { length: 0, getLine: () => undefined } } }, 1), [])
const click = { button: 0, clientX: 12, clientY: 21, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }
const down = { x: 10, y: 20 }
check('a plain click opens in Stoke on both desktop platforms', [terminalLinkClick(url, click, down, true), terminalLinkClick(url, click, down, false)], ['stoke', 'stoke'])
check('platform browser modifiers and Shift open externally', [terminalLinkClick(url, { ...click, metaKey: true }, down, true), terminalLinkClick(url, { ...click, ctrlKey: true }, down, false), terminalLinkClick(url, { ...click, shiftKey: true }, down, true)], ['external', 'external', 'external'])
check('selection, secondary clicks and Mac Ctrl-click cannot open a link', [terminalLinkClick(url, { ...click, clientX: 14 }, down, false), terminalLinkClick(url, { ...click, altKey: true }, down, true), terminalLinkClick(url, { ...click, ctrlKey: true }, down, true), terminalLinkClick(url, { ...click, button: 2 }, down, false)], [null, null, null, null])
check('an activation without a press or with a non-web target is refused', [terminalLinkClick(url, click, null, false), terminalLinkClick('file:///etc/passwd', click, down, false)], [null, null])
console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
