/*
 * xterm measures every character against a width table, and Claude Code's TUI
 * measures the same characters against a different one. When they disagree the
 * terminal tears: a glyph the CLI drew two cells wide is stored in one, so
 * everything after it on that line is off by one and box drawing does not meet.
 *
 * xterm ships Unicode 6 tables — 2010 — so every emoji added since is one cell
 * wide to it. This suite pins which provider is loaded and what it measures,
 * against the real addon rather than a description of it.
 *
 *   node scripts/verify-unicode.mts
 */
import pkg from '@xterm/headless'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

// Default import: @xterm/headless is CJS and exposes no named ESM exports, so
// `import { Terminal } from '@xterm/headless'` throws at link time.
const { Terminal } = pkg

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const term = new Terminal({ cols: 120, rows: 6, allowProposedApi: true })

/** The callback form, so nothing here depends on a timer. */
function write(s: string): Promise<void> {
  return new Promise<void>((r) => term.write(s, r))
}

/** Write one string on a fresh line and report what the buffer holds. */
async function measure(s: string): Promise<{
  cursorX: number
  w0: number
  c0: string
}> {
  await write('\r\n')
  await write(s)
  const b = term.buffer.active
  // cursorY is viewport-relative (0..rows-1 per the IBuffer typings) and stays
  // pinned once the buffer scrolls, while getLine wants an absolute index —
  // without + baseY, every row after the first scroll reads the frozen line
  // from the moment scrolling began instead of what was just written.
  const line = b.getLine(b.baseY + b.cursorY)!
  return { cursorX: b.cursorX, w0: line.getCell(0)!.getWidth(), c0: line.getCell(0)!.getChars() }
}

console.log('\nwhat xterm measures with out of the box')
check('the built-in provider is Unicode 6', term.unicode.activeVersion, '6')
check('and it is the only one registered', term.unicode.versions, ['6'])
check('U+1FA9F is one cell wide, which is the bug', await measure('\u{1FA9F}'), {
  cursorX: 1,
  w0: 1,
  c0: '\u{1FA9F}'
})
check('so is U+1F5D3 with its variation selector', await measure('\u{1F5D3}\u{FE0F}'), {
  cursorX: 1,
  w0: 1,
  c0: '\u{1F5D3}\u{FE0F}'
})
check('and so is a 2010 emoji', await measure('\u{1F600}'), {
  cursorX: 1,
  w0: 1,
  c0: '\u{1F600}'
})
{
  const box = await measure('█'.repeat(30))
  check('a full block is one cell, and thirty of them are thirty', [box.cursorX, box.w0], [30, 1])
}

console.log('\nwith the graphemes provider loaded')
term.loadAddon(new UnicodeGraphemesAddon())
check('the addon selects itself', term.unicode.activeVersion, '15-graphemes')
check('and registers both of its tables', term.unicode.versions, ['6', '15', '15-graphemes'])

console.log('\nwhy 15-graphemes and not 15')
term.unicode.activeVersion = '15'
check(
  "plain '15' splits the variation selector into its own cell, which is worse than today",
  (await measure('\u{1F5D3}\u{FE0F}')).cursorX,
  3
)
term.unicode.activeVersion = '15-graphemes'

console.log('\nthe widths the CLI drew those characters at')
check('U+1FA9F is two cells, in one cell holding one glyph', await measure('\u{1FA9F}'), {
  cursorX: 2,
  w0: 2,
  c0: '\u{1FA9F}'
})
check('U+1F5D3 + VS16 is two cells, clustered', await measure('\u{1F5D3}\u{FE0F}'), {
  cursorX: 2,
  w0: 2,
  c0: '\u{1F5D3}\u{FE0F}'
})
check('and a 2010 emoji agrees', await measure('\u{1F600}'), {
  cursorX: 2,
  w0: 2,
  c0: '\u{1F600}'
})
{
  const box = await measure('█'.repeat(30))
  check(
    'U+2588 is East-Asian Ambiguous and STAYS one cell, which is what the CLI assumes too',
    [box.cursorX, box.w0],
    [30, 1]
  )
}
check('and ASCII is untouched', (await measure('AB')).cursorX, 2)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
