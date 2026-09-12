/*
 * The campfire the installer burns: the art, the frame selection, the four
 * colour tiers, and the degraded path.
 *
 *   node scripts/verify-campfire.mts
 *
 * What this suite CANNOT see, said out loud because gotcha 31 is the recurring
 * lesson in this repo and this feature is unusually exposed to it. Nothing here
 * proves that a Windows console actually renders the sequences, that the cursor
 * comes back after Ctrl-C or a hard kill, or that the canvas stays put when the
 * terminal scrolls at the bottom of the window. Those need a real run:
 * `node scripts/campfire-demo.mts` is the harness, and the three boxes worth
 * ticking are macOS Terminal or iTerm, Windows Terminal + pwsh, and bare conhost
 * + PowerShell 5.1.
 *
 * What it CAN see is everything that has already gone wrong once: art drifting
 * out of the alphabet that makes it quotable in two shells at once, a hearth
 * moving under a growing flame, a hand-edited segment printing a literal `||`,
 * and an escape byte reaching a CI log.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALPHABET,
  CANVAS,
  ESC,
  FLICKER,
  HEARTH,
  STAGES,
  STAGE_THRESHOLDS,
  colorFor,
  colorMode,
  decileOf,
  decodeRow,
  degradedReason,
  encodeRow,
  frameFor,
  inAlphabet,
  paint,
  plainProgress,
  renderPlan,
  stageFor,
  type ColorMode,
  type Terminal
} from '../src/shared/campfire.ts'
import { BEGIN_MARK, END_MARK, extractBlock, ps1ArtBlock, shArtBlock } from './gen-installer-art.mts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}` + (condition || !detail ? '' : `\n        ${detail}`))
}

/** Every frame as its seven rows, in draw order. */
const FRAMES: string[][] = STAGES.flatMap((s) => s.frames.map((f) => [...f, ...HEARTH]))
/** Escapes made readable, so a failing golden sheet can be diffed by eye. */
const show = (s: string): string => s.split(ESC).join('\\e')

console.log('\nthe canvas')
check('twelve frames', FRAMES.length, 12)
check('four stages of three flicker frames', STAGES.map((s) => s.frames.length), [3, 3, 3, 3])
ok(
  `every frame is exactly ${CANVAS.rows} rows`,
  FRAMES.every((f) => f.length === CANVAS.rows),
  FRAMES.map((f) => f.length).join(',')
)
ok(
  `no row is wider than ${CANVAS.cols} columns`,
  FRAMES.every((f) => f.every((r) => r.length <= CANVAS.cols)),
  JSON.stringify(FRAMES.flat().filter((r) => r.length > CANVAS.cols))
)
/*
 * Right-trimmed, because the renderer emits ESC[K per row instead of padding:
 * 3 bytes rather than up to 15, and correct at any window width. A row with
 * trailing spaces would still draw correctly and would silently cost bytes.
 */
ok(
  'flame rows carry no trailing space',
  FRAMES.every((f) => f.every((r) => r === r.replace(/\s+$/, ''))),
  JSON.stringify(FRAMES.flat().filter((r) => r !== r.replace(/\s+$/, '')))
)

console.log('\nthe hearth never moves')
/*
 * This is the assertion a screenshot cannot make. The fire growing only reads
 * as growth because the ground under it is byte-identical in all twelve frames;
 * one frame's hearth shifted by a column would read as a flicker in the logs
 * and nobody would know why the animation looked cheap.
 */
ok(
  'the last two rows of every frame are the hearth, byte for byte',
  FRAMES.every((f) => f[5] === HEARTH[0] && f[6] === HEARTH[1]),
  JSON.stringify(FRAMES.map((f) => f.slice(5)).filter((h) => h[0] !== HEARTH[0] || h[1] !== HEARTH[1]))
)
check('both hearth rows are the full width', HEARTH.map((r) => r.length), [CANVAS.cols, CANVAS.cols])

console.log('\nthe alphabet, which is a quoting contract')
/*
 * The same bytes have to sit inside a POSIX single-quoted string AND a
 * PowerShell here-string, unescaped. Each ban below is one way that stops
 * being true; the apostrophe is the load-bearing one, and is why the sparks
 * are `^` and the ground is `.-.,...,.-.` rather than `'-.,...,.-'`.
 */
const artText = FRAMES.flat().join('')
ok('every glyph is in the alphabet', inAlphabet(artText), JSON.stringify([...new Set(artText)].join('')))
for (const [name, ch] of [
  ['apostrophe (ends a POSIX single-quoted string)', "'"],
  ['backtick (PowerShell escape; POSIX command substitution)', '`'],
  ['dollar (expands in both shells)', '$'],
  ['double quote (a quoting collision in both)', '"'],
  ['at sign (a line starting `@ ends a PowerShell here-string)', '@'],
  ['pipe (the segment delimiter)', '|'],
  ['colon (the key delimiter)', ':']
] as const) {
  ok(`no ${name}`, !artText.includes(ch))
}
ok(
  'nothing above 0x7E: the base art is pure ASCII, so a cp437 console cannot mojibake it',
  [...artText].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e)
)
check('the alphabet itself has not grown', ALPHABET, ' ()/\\_-.,*#=^')

console.log('\nstage boundaries, from both sides')
check('nothing downloaded yet is already a spark', stageFor(0), 'spark')
check('just under the first threshold', stageFor(0.0799), 'spark')
check('exactly on it', stageFor(STAGE_THRESHOLDS[0]), 'kindling')
check('just under the second', stageFor(0.3499), 'kindling')
check('exactly on it', stageFor(STAGE_THRESHOLDS[1]), 'burning')
check('just under the third', stageFor(0.7499), 'burning')
check('exactly on it', stageFor(STAGE_THRESHOLDS[2]), 'roaring')
check('finished', stageFor(1), 'roaring')
check('a negative progress clamps rather than throwing', stageFor(-1), 'spark')
check('so does one over 1', stageFor(2), 'roaring')
check('and NaN, which is what a divide by a zero Content-Length gives', stageFor(NaN), 'spark')

console.log('\nframe selection is deterministic')
/*
 * No RNG and no clock, so a test can pin every frame. A three-frame cycle
 * would read as a metronome, which is why FLICKER is six entries long.
 */
check('the flicker cycle', [...FLICKER], [0, 1, 2, 1, 0, 2])
let stable = true
for (let i = 0; i < 1000; i++) {
  const a = frameFor(0.5, i % 13).join('\n')
  const b = frameFor(0.5, i % 13).join('\n')
  if (a !== b) stable = false
}
ok('1000 calls with the same (progress, tick) give the same rows', stable)
check(
  'the tick wraps at six',
  frameFor(0.5, 6).join('|') === frameFor(0.5, 0).join('|') && frameFor(0.5, 7).join('|') === frameFor(0.5, 1).join('|'),
  true
)
check('a negative tick does not fall off the front of the array', frameFor(0.5, -1).length, CANVAS.rows)

console.log('\nwhich glyph gets which colour')
/*
 * Colouring by ROW alone is the obvious implementation and it is wrong: at the
 * spark stage the only content is on rows 3-4, so a row map paints the ember in
 * the DIMMEST tier and the fire opens looking like ash. Glyph class first.
 */
check('a core glyph is white-hot even on the bottom flame row', colorFor('#', 4), 'C')
check('and at the top', colorFor('*', 0), 'C')
check('the lone ember at spark stage is a core inside a base ring', frameFor(0, 0)[4], '      (*)')
check('  its centre', colorFor('*', 4), 'C')
check('  its ring', colorFor('(', 4), 'B')
check('a spark glyph is a spark wherever it is', colorFor('^', 4), 'S')
check('an ordinary glyph takes its row colour, high', colorFor('(', 1), 'S')
check('  middle', colorFor('(', 2), 'M')
check('  low', colorFor(')', 4), 'B')
check('the hearth is log-coloured whatever the glyph', colorFor('.', 5), 'L')
check('  including its dashes and commas', colorFor(',', 6), 'L')
check('a space is never painted', colorFor(' ', 0), '_')
check('  not even in the hearth', colorFor(' ', 6), '_')

console.log('\nthe segment encoding round-trips')
/*
 * The one defect this whole generator exists to prevent. The encoding was
 * written by hand once and shipped `(|#|=|` and a stray trailing pair into a
 * running script; both printed a literal `||` on screen and were found only by
 * reading a real run's stripped output.
 */
let rt = 0
for (const frame of FRAMES) {
  frame.forEach((row, i) => {
    if (decodeRow(encodeRow(row, i)) !== row) rt++
  })
}
check('every row of every frame decodes back to itself', rt, 0)
check('an empty row encodes to nothing', encodeRow('', 0), '')
check('and decodes back', decodeRow(''), '')
check(
  'the encoding is the one the installers carry',
  encodeRow('      (*)', 4),
  '_:      |B:(|C:*|B:)'
)
const refuses = (encoded: string): boolean => {
  try {
    decodeRow(encoded)
    return false
  } catch {
    return true
  }
}
ok('a segment with no key throws rather than being read as literal text', refuses('_:  |oops'))
ok('  so does one naming a colour that does not exist', refuses('_:  |Z:.'))
ok('  and the stray delimiter that shipped once', refuses('B:(|#|=|'))

console.log('\ncolour tiers')
const tty: Terminal = { isTty: true, platform: 'darwin', rows: 40, cols: 100 }
const win: Terminal = { isTty: true, platform: 'win32', rows: 40, cols: 100 }
check('a 256-colour TERM', colorMode({ TERM: 'xterm-256color' }, tty), 'ansi256')
check('COLORTERM wins over TERM', colorMode({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, tty), 'truecolor')
check('so does 24bit, which is the other spelling', colorMode({ TERM: 'xterm', COLORTERM: '24bit' }, tty), 'truecolor')
check('a plain TERM gets the 8-colour-safe tier', colorMode({ TERM: 'xterm' }, tty), 'ansi16')
/*
 * The Windows rule, pinned to the documentation it came from: the console host
 * "will choose the nearest appropriate color from the existing 16 color table"
 * for anything richer, and its rounding table cannot be modified -- #e85f24,
 * #ff9552 and #ffc48c are close enough that it can collapse all three into one
 * red. So the 16-colour tier is chosen for bare conhost by design. TERM is not
 * consulted there at all: a false positive prints a raw escape sequence as the
 * first thing Stoke ever does.
 */
check('bare Windows gets 16 colours by design, not by degradation', colorMode({}, win), 'ansi16')
check('  even with a 256-colour TERM, which conhost would round anyway', colorMode({ TERM: 'xterm-256color' }, win), 'ansi16')
check('Windows Terminal is truecolor', colorMode({ WT_SESSION: '1' }, win), 'truecolor')
check('  and so is anything setting COLORTERM there', colorMode({ COLORTERM: 'truecolor' }, win), 'truecolor')

console.log('\nNO_COLOR governs colour, not motion')
/*
 * no-color.org: the variable, "when present and not an empty string (regardless
 * of its value), prevents the addition of ANSI color". It says nothing about
 * animation, and the art is a silhouette that reads perfectly without colour.
 * The empty-string case is the part everyone gets wrong.
 */
check('NO_COLOR=1 removes the colour', colorMode({ TERM: 'xterm-256color', NO_COLOR: '1' }, tty), 'none')
check('  including NO_COLOR=0, because any non-empty value counts', colorMode({ TERM: 'xterm-256color', NO_COLOR: '0' }, tty), 'none')
check('  but it still animates', renderPlan({ TERM: 'xterm-256color', NO_COLOR: '1' }, tty).animate, true)
check('NO_COLOR= (empty) is explicitly NOT a trigger', colorMode({ TERM: 'xterm-256color', NO_COLOR: '' }, tty), 'ansi256')

console.log('\nwhat sends it to the degraded path')
check('a pipe', degradedReason({ TERM: 'xterm' }, { ...tty, isTty: false }), 'stdout is not a terminal')
check('TERM=dumb', degradedReason({ TERM: 'dumb' }, tty), 'TERM is dumb')
check('no TERM at all, on POSIX', degradedReason({}, tty), 'TERM is unset')
check('  but an absent TERM is normal on Windows', degradedReason({}, win), null)
check('CI', degradedReason({ TERM: 'xterm', CI: 'true' }, tty), 'this is CI')
check('  GitHub Actions', degradedReason({ TERM: 'xterm', GITHUB_ACTIONS: 'true' }, tty), 'this is CI')
check('  Azure Pipelines', degradedReason({ TERM: 'xterm', TF_BUILD: 'True' }, tty), 'this is CI')
check('the explicit escape hatch', degradedReason({ TERM: 'xterm', STOKE_NO_ANIMATION: '1' }, tty), 'STOKE_NO_ANIMATION is set')
/*
 * Microsoft's own doc: "Cursor movement will be bounded by the current viewport
 * into the buffer." In a window shorter than the canvas plus chrome, ESC[7A
 * clamps and the fire smears up the screen instead of redrawing in place.
 */
check('a window too short for the canvas', degradedReason({ TERM: 'xterm' }, { ...tty, rows: 8 }), 'the window is under 12 rows')
check('a window too narrow for it', degradedReason({ TERM: 'xterm' }, { ...tty, cols: 15 }), 'the window is under 20 columns')
check('an unknown window size is not a reason to give up', degradedReason({ TERM: 'xterm' }, { isTty: true, platform: 'linux' }), null)
check('an ordinary terminal animates', renderPlan({ TERM: 'xterm-256color' }, tty), {
  animate: true,
  color: 'ansi256',
  reason: null
})

console.log('\npainting')
/*
 * The single most valuable assertion in this file. A stray escape byte in a CI
 * log is the failure people actually report, and `none` is the tier every
 * redirected run, every dumb terminal and every NO_COLOR user gets.
 */
ok('no frame painted in `none` mode contains an escape byte at all', !FRAMES.some((f) => paint(f, 'none').includes(ESC)))
check('`none` is the art verbatim', paint(FRAMES[0], 'none'), FRAMES[0].join('\n'))
const MODES: ColorMode[] = ['truecolor', 'ansi256', 'ansi16', 'none']
let lost = 0
for (const mode of MODES) {
  for (const frame of FRAMES) {
    const stripped = paint(frame, mode).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
    if (stripped !== frame.join('\n')) lost++
  }
}
check('stripping the colour from any tier gives the art back, glyph for glyph', lost, 0)
ok(
  'a painted row ends with a reset, so the next thing printed is not on fire',
  MODES.filter((m) => m !== 'none').every((m) =>
    paint([HEARTH[0]], m).endsWith(`${ESC}[0m`)
  )
)
ok(
  'paint colours nothing itself: no cursor movement, no erase, no alternate screen',
  MODES.every((m) => !/\[[0-9]*[AKJ]|\[\?1049/.test(paint(FRAMES[9], m)))
)

console.log('\nthe golden sheet')
/*
 * All twelve frames painted in one tier, hashed. Same instinct as
 * verify:theme-gen's byte-identical reproduction: this is what stops a
 * plausible-looking tweak to the palette, the segmentation or the art from
 * landing unnoticed. If one of these fails, run
 * `node scripts/campfire-demo.mts --sweep --mode=<tier>` and look at it.
 */
const GOLDEN: Record<ColorMode, string> = {
  truecolor: '5de6f23a6bfb8292ac3408bcbfc1c93aa03fffddebb221a892dea6783deda733',
  ansi256: '1597644b13381254cff867ba562c205d182be71675449cb856980489fd70b393',
  ansi16: '4372b3f297520dd366dcacc624886cdc2bdcadd4601b45772e0061a2634d7763',
  none: '2825b429ec3cde4a41b3d0c296f5487e642184ffd8bccbc4883b3d1c3f7dace1'
}
for (const mode of MODES) {
  const sheet = FRAMES.map((f) => paint(f, mode)).join('\n--\n')
  const got = createHash('sha256').update(sheet).digest('hex')
  const good = got === GOLDEN[mode]
  if (!good) failures++
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${mode} sheet`)
  if (!good) {
    console.log(`        got ${got}, want ${GOLDEN[mode]}`)
    console.log(show(sheet).replace(/^/gm, '        '))
  }
}

console.log('\nthe degraded path prints one honest line per decile')
check('the first tick', plainProgress(0, 86_100_000, -1), '    0%  0.0 MB')
check('nothing yet at the same decile', plainProgress(1_000_000, 86_100_000, 0), null)
check('the next decile', plainProgress(8_800_000, 86_100_000, 0), '   10%  8.8 MB')
check('the last one', plainProgress(86_100_000, 86_100_000, 9), '  100%  86.1 MB')
check('a decile already printed is never printed twice', plainProgress(86_100_000, 86_100_000, 10), null)
/*
 * A fabricated percentage in a log someone later reads back is worse than no
 * percentage at all, so a chunked response gets megabytes alone -- and still
 * only every 10 MB, not eight times a second.
 */
check('no Content-Length means no percentage', plainProgress(8_600_000, null, -1), '   8.6 MB')
check('  and it still rations itself', plainProgress(8_600_000, null, 0), null)
check('  stepping every 10 MB', plainProgress(10_000_000, null, 0), '  10.0 MB')
check('a zero Content-Length is treated as unknown, never divided by', plainProgress(5_000_000, 0, -1), '   5.0 MB')
check('the decile of a finished download', decileOf(86_100_000, 86_100_000), 10)
check('  and it cannot exceed ten if the server undercounted', decileOf(90_000_000, 86_100_000), 10)
const emitted: string[] = []
let last = -1
for (let i = 0; i <= 320; i++) {
  const got = Math.round((86_100_000 * i) / 320)
  const line = plainProgress(got, 86_100_000, last)
  if (line !== null) {
    emitted.push(line)
    last = decileOf(got, 86_100_000)
  }
}
check('320 ticks produce eleven lines, not 320', emitted.length, 11)
ok(
  'and not one of them carries an escape byte or a carriage return',
  emitted.every((l) => !l.includes(ESC) && !l.includes('\r')),
  JSON.stringify(emitted)
)
check('they end where the download does', emitted[emitted.length - 1], '  100%  86.1 MB')

console.log('\nthe generated art blocks')
const sh = shArtBlock()
const ps1 = ps1ArtBlock()
/** The quoted values out of the sh block: `NAME='...'`, newlines and all. */
function shValues(block: string): Map<string, string> {
  return new Map([...block.matchAll(/^([A-Z_0-9]+)='([\s\S]*?)'$/gm)].map((m) => [m[1], m[2]]))
}
/** The same out of the ps1 block's here-strings. */
function ps1Values(block: string): Map<string, string> {
  return new Map([...block.matchAll(/^\$(\w+) = @'\n([\s\S]*?)\n'@$/gm)].map((m) => [m[1], m[2]]))
}
const shVals = shValues(sh)
const ps1Vals = ps1Values(ps1)

for (const [name, block] of [
  ['sh', sh],
  ['ps1', ps1]
] as const) {
  ok(`${name}: begins and ends with its sentinel`, block.startsWith(BEGIN_MARK) && block.trimEnd().endsWith(END_MARK))
  ok(`${name}: carries no ESC byte — the palette is the bytes AFTER it`, !block.includes(ESC))
  /*
   * The alternate screen buffer is "exactly the dimensions of the window,
   * without any scrollback region", and leaving it restores the original --
   * which erases everything the installer printed, including where it put the
   * app and what to add to PATH. An installer's transcript is the product, and
   * a `curl | sh` nobody can scroll back through is not auditable either.
   * Asserted rather than merely agreed, so a future "let's just use the alt
   * screen" cannot land quietly.
   */
  ok(`${name}: never touches the alternate screen buffer`, !block.includes('1049'))
}
check('the sh block holds twelve encoded frames, twelve plain ones and one hearth pair', [
  [...shVals.keys()].filter((k) => /^FIRE_F\d+$/.test(k)).length,
  [...shVals.keys()].filter((k) => /^FIRE_M\d+$/.test(k)).length,
  shVals.has('FIRE_FH') && shVals.has('FIRE_MH')
], [12, 12, true])
/*
 * The assertion that protects both scripts at once. A payload carrying an
 * apostrophe would end its own POSIX string mid-art and take the rest of the
 * script with it; a `@` at the start of a line would end a PowerShell
 * here-string the same way. Checked on what the generator actually WROTE
 * rather than on the source art, because the encoding sits in between.
 */
const badPayload = [...shVals.entries(), ...ps1Vals.entries()].filter(([, v]) =>
  v.split('\n').some((line) => /['"`$@]/.test(line))
)
ok('no payload contains a quote, a backtick, a dollar or an at sign', badPayload.length === 0, JSON.stringify(badPayload))
/*
 * The same claim made where a parse cannot hide it. Both readers above find a
 * value by matching up to its closing quote, so a payload that DID contain an
 * apostrophe would simply end the match early and pass -- the check would be
 * satisfied by the very break it exists to catch. This one asks the module.
 */
const badEncoded = FRAMES.flatMap((f) => f.map((r, i) => encodeRow(r, i))).filter((e) => /['"`$@]/.test(e))
ok('nor does any row the encoder produces, asked of the encoder itself', badEncoded.length === 0, JSON.stringify(badEncoded))
const plainRows = [...shVals.entries()]
  .filter(([k]) => /^FIRE_M(\d+|H)$/.test(k))
  .flatMap(([, v]) => v.split('\n'))
ok('every plain row the block carries is in the alphabet', plainRows.every(inAlphabet), JSON.stringify(plainRows.filter((r) => !inAlphabet(r))))
const decoded = [...shVals.entries()]
  .filter(([k]) => /^FIRE_F(\d+|H)$/.test(k))
  .flatMap(([, v]) => v.split('\n').map(decodeRow))
ok('and so is every row decoded out of the segment-encoded ones', decoded.every(inAlphabet), JSON.stringify(decoded.filter((r) => !inAlphabet(r))))
/*
 * The colour is generated, so the two forms of the art in the block cannot be
 * allowed to drift apart: decoding the encoded frames must give the plain ones.
 * This is the decode(encode(x)) === x assertion applied to the shipped bytes
 * rather than to the module.
 */
let blockRt = 0
for (let i = 0; i < 12; i++) {
  if (shVals.get(`FIRE_F${i}`)!.split('\n').map(decodeRow).join('\n') !== shVals.get(`FIRE_M${i}`)) blockRt++
}
if (shVals.get('FIRE_FH')!.split('\n').map(decodeRow).join('\n') !== shVals.get('FIRE_MH')) blockRt++
check('decoding the block\'s own encoded frames gives its own plain frames', blockRt, 0)
const drift = [...Array(12).keys()].filter((i) => shVals.get(`FIRE_F${i}`) !== ps1Vals.get(`FireF${i}`))
check('the sh and ps1 blocks carry the same art', drift, [])

console.log('\nthe shipped installer scripts still match the generator')
/*
 * Two files that must agree, maintained by hand, will diverge -- including a
 * file whose own comment says not to edit it (gotcha 62). So the block is
 * COMPARED rather than trusted: any file in the repo carrying the sentinel must
 * equal what the generator emits for its kind.
 */
const carriers = filesWithSentinel(root)
if (carriers.length === 0) {
  console.log(
    '  SKIP  no file carries the sentinel yet. The installer scripts are a later stream;\n' +
      `        when installer/install.sh and installer/install.ps1 land with a ${BEGIN_MARK}\n` +
      '        block pasted from `node scripts/gen-installer-art.mts`, this compares them.'
  )
} else {
  for (const file of carriers) {
    const want = file.endsWith('.ps1') ? ps1 : sh
    const got = extractBlock(readFileSync(file, 'utf8'))
    const rel = relative(root, file)
    ok(`${rel} carries the generator's block byte for byte`, got === want, got === null ? 'no sentinel pair' : 'regenerate it: node scripts/gen-installer-art.mts ' + (file.endsWith('.ps1') ? 'ps1' : 'sh'))
  }
}
for (const named of ['installer/install.sh', 'installer/install.ps1']) {
  const path = join(root, named)
  if (existsSync(path) && !readFileSync(path, 'utf8').includes(BEGIN_MARK)) {
    ok(`${named} carries the generated block rather than hand-written art`, false, `add the ${BEGIN_MARK} block`)
  }
}

function filesWithSentinel(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'out', 'release', 'dist', 'build'].includes(entry)) continue
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) {
      filesWithSentinel(path, out)
      continue
    }
    if (!/\.(sh|ps1|bash|cmd|txt)$/.test(entry) || st.size > 512_000) continue
    if (readFileSync(path, 'utf8').includes(BEGIN_MARK)) out.push(path)
  }
  return out
}

console.log('\nthe sh block through real shells')
/*
 * The quoting contract, executed rather than reasoned about. Both halves are
 * measured facts rather than style: bash 3.2.57 -- which is what `#!/bin/sh`
 * gets on every Mac -- is a syntax error on `$(cat <<EOF ... EOF)` whose body
 * has unbalanced parens, and the art is nothing but unbalanced parens; and a
 * `$(...)` strips the trailing newline off a painted frame, losing a row. Plain
 * single-quoted assignments avoid both, which is only true while the art stays
 * inside its alphabet.
 */
if (process.platform === 'win32') {
  console.log('  SKIP  no POSIX shell here. This is the half of the contract a Windows runner cannot check.')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'campfire-'))
  const driver = [
    '',
    'n=0',
    'while [ "$n" -lt 12 ]; do',
    '  eval "enc=\\$FIRE_F$n"',
    '  eval "plain=\\$FIRE_M$n"',
    "  printf '%s\\n' \"$enc\"",
    "  printf '%s\\n' \"$plain\"",
    '  n=$((n+1))',
    'done',
    "printf '%s\\n' \"$FIRE_FH\"",
    "printf '%s\\n' \"$FIRE_MH\"",
    "printf '%s %s %s\\n' \"$FIRE_ROWS\" \"$FIRE_FLICKER\" \"$FIRE_STAGE_PCT\"",
    ''
  ].join('\n')
  const script = join(dir, 'art.sh')
  writeFileSync(script, sh + driver)
  const want =
    FRAMES.map((f) => f.slice(0, 5))
      .map((rows) => rows.map((r, y) => encodeRow(r, y)).join('\n') + '\n' + rows.join('\n'))
      .join('\n') +
    '\n' +
    HEARTH.map((r, y) => encodeRow(r, y + 5)).join('\n') +
    '\n' +
    HEARTH.join('\n') +
    '\n7 0 1 2 1 0 2 8 35 75\n'
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash']) {
    if (!existsSync(shell)) {
      console.log(`  SKIP  ${shell} is not on this machine`)
      continue
    }
    let got = ''
    let why = ''
    try {
      execFileSync(shell, ['-n', script], { encoding: 'utf8' })
      got = execFileSync(shell, [script], { encoding: 'utf8' })
    } catch (e) {
      why = String((e as { stderr?: string }).stderr ?? e).trim()
    }
    ok(`${shell} reproduces the art byte for byte`, got === want, why || firstDiff(got, want))
  }
  rmSync(dir, { recursive: true, force: true })
}

function firstDiff(got: string, want: string): string {
  const g = got.split('\n')
  const w = want.split('\n')
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) return `line ${i}: got ${JSON.stringify(g[i])}, want ${JSON.stringify(w[i])}`
  }
  return ''
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
