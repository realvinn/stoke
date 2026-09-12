/*
 * The committed installer artwork: that it is the exact format the Windows NSIS
 * wizard and the macOS dmg can actually read, and that the four places naming
 * these files still agree with each other.
 *
 * This suite is not garnish. electron-builder validates NONE of these assets —
 * no magic bytes, no dimensions, no bit depth. Its NSIS validation greps
 * makensis stderr for /^Error:/ lines and compares the installer's size to its
 * payload, and that is all. So a PNG renamed .bmp, or a BMP carrying the
 * BITMAPV4/V5 header that ImageMagick and Photoshop write by default, produces
 * a makensis *warning*, a blank or garbled image in the wizard, and exit 0.
 * Wrong DIMENSIONS produce no diagnostic at all: MUI stretches to fit. That is
 * CLAUDE.md gotcha 62's shape exactly — a green build over a broken artefact —
 * and it is why this suite was written in the same change as the art.
 *
 * NSIS loads these through the Win32 LoadImage, which only understands the
 * classic 40-byte BITMAPINFOHEADER ("BMP3" / "Windows 3.x"). Every field
 * asserted below is one LoadImage reads.
 *
 * Nothing here can prove the wizard RENDERS them: no round of work in this repo
 * has run on Windows. What it can prove is that the bytes are the ones the
 * documented loader accepts, which is the half that is checkable from a Mac.
 *
 *   node scripts/verify-installer-art.mts
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BUILD = join(ROOT, 'build')

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

/* ------------------------------------------------------------------ *
 * The bitmaps, decoded by hand rather than through the encoder that
 * wrote them: a decoder that shares code with its encoder agrees with
 * it by construction and proves nothing about the format.
 * ------------------------------------------------------------------ */

type Bmp = {
  magic: string
  fileSize: number
  offBits: number
  infoSize: number
  width: number
  height: number
  planes: number
  bitCount: number
  compression: number
  bytes: number
}

function readBmp(file: string): Bmp {
  const b = readFileSync(join(BUILD, file))
  return {
    magic: b.subarray(0, 2).toString('ascii'),
    fileSize: b.readUInt32LE(2),
    offBits: b.readUInt32LE(10),
    infoSize: b.readUInt32LE(14),
    width: b.readInt32LE(18),
    height: b.readInt32LE(22),
    planes: b.readUInt16LE(26),
    bitCount: b.readUInt16LE(28),
    compression: b.readUInt32LE(30),
    bytes: b.length,
  }
}

/** Every pixel, as {r,g,b}, walking the bottom-up rows and the BGR channels. */
function bmpPixels(file: string): Array<{ r: number; g: number; b: number }> {
  const buf = readFileSync(join(BUILD, file))
  const width = buf.readInt32LE(18)
  const height = buf.readInt32LE(22)
  const off = buf.readUInt32LE(10)
  const rowSize = (width * 3 + 3) & ~3
  const out: Array<{ r: number; g: number; b: number }> = []
  for (let y = 0; y < height; y++) {
    let p = off + y * rowSize
    for (let x = 0; x < width; x++) {
      out.push({ b: buf[p], g: buf[p + 1], r: buf[p + 2] })
      p += 3
    }
  }
  return out
}

const BITMAPS = [
  {
    file: 'installerSidebar.bmp',
    width: 164,
    height: 314,
    /* The welcome/finish bitmap. Dark: it is Stoke's own page colour. */
    dark: true,
    /* The flame's core is near-white, so the brightest pixel is very bright. */
    minPeakRed: 240,
    minColors: 400,
  },
  {
    file: 'uninstallerSidebar.bmp',
    width: 164,
    height: 314,
    dark: true,
    /* Embers only — no core, so the peak is an ember rather than a flame. */
    minPeakRed: 150,
    minColors: 400,
  },
  {
    file: 'installerHeader.bmp',
    width: 150,
    height: 57,
    /*
     * LIGHT on purpose, and this assertion is the point of pinning it. The
     * header image is forced to the right of MUI's header strip
     * (NsisTarget sets MUI_HEADERIMAGE_RIGHT unconditionally, with no option to
     * move it) and MUI_BGCOLOR defaults to FFFFFF, so a dark tile reads as a
     * dark rectangle glued onto a pale bar. Going dark is legitimate, but only
     * together with MUI_BGCOLOR/MUI_TEXTCOLOR overrides from a top-level
     * build/installer.nsh — so it has to be a deliberate change here too, not a
     * redraw nobody noticed.
     */
    dark: false,
    minPeakRed: 200,
    /* A small mark on a large white ground, so far fewer colours than a page
       of gradient — still three orders of magnitude away from a blank. */
    minColors: 120,
  },
]

console.log('\nBMP3 header, the only format NSIS LoadImage displays')
for (const want of BITMAPS) {
  const bmp = readBmp(want.file)
  const rowSize = (want.width * 3 + 3) & ~3
  const expectedBytes = 54 + rowSize * want.height

  check(`${want.file}: BM magic`, bmp.magic, 'BM')
  check(`${want.file}: biSize 40 (BITMAPINFOHEADER; V4/V5 are not displayed)`, bmp.infoSize, 40)
  check(`${want.file}: biBitCount 24 (BMP3 has no alpha and NSIS ignores it anyway)`, bmp.bitCount, 24)
  check(`${want.file}: biCompression 0 (BI_RGB)`, bmp.compression, 0)
  check(`${want.file}: biPlanes 1`, bmp.planes, 1)
  check(`${want.file}: biWidth ${want.width}`, bmp.width, want.width)
  check(`${want.file}: biHeight ${want.height}`, bmp.height, want.height)
  ok(
    `${want.file}: biHeight is POSITIVE, so the rows are bottom-up`,
    bmp.height > 0,
    `biHeight is ${bmp.height}; a negative height is top-down and not what the encoder writes`
  )
  check(`${want.file}: pixels start at byte 54, straight after the two headers`, bmp.offBits, 54)
  check(`${want.file}: the file is exactly header + 4-byte-padded rows`, bmp.bytes, expectedBytes)
  check(`${want.file}: bfSize agrees with the file on disk`, bmp.fileSize, bmp.bytes)
}

/*
 * Everything above would pass over a correctly-formatted rectangle of solid
 * black — which is exactly what a rasterisation that silently produced nothing
 * would write. So: the art has to actually be there, and it has to be warm.
 */
console.log('\nthe bitmaps carry art, not a correctly-formatted blank')
const MEAN_LUMA = new Map<string, number>()
for (const want of BITMAPS) {
  const px = bmpPixels(want.file)
  check(`${want.file}: pixel count`, px.length, want.width * want.height)

  const distinct = new Set(px.map((p) => (p.r << 16) | (p.g << 8) | p.b)).size
  ok(`${want.file}: more than ${want.minColors} distinct colours (${distinct})`, distinct > want.minColors)

  const peakRed = px.reduce((m, p) => (p.r > m ? p.r : m), 0)
  ok(
    `${want.file}: something in it is genuinely lit (peak red ${peakRed} >= ${want.minPeakRed})`,
    peakRed >= want.minPeakRed
  )

  const warm = px.filter((p) => p.r - p.b >= 24).length
  ok(`${want.file}: a warm region exists (${warm} pixels with R-B >= 24)`, warm > 200)

  const mean = px.reduce((s, p) => s + 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b, 0) / px.length
  MEAN_LUMA.set(want.file, mean)
  if (want.dark) {
    ok(`${want.file}: reads dark, like the app's own page (mean luma ${mean.toFixed(1)} < 70)`, mean < 70)
  } else {
    ok(
      `${want.file}: reads LIGHT, because MUI_BGCOLOR is FFFFFF (mean luma ${mean.toFixed(1)} > 200)`,
      mean > 200
    )
  }
}

/*
 * The two sidebars are the same size, the same palette and the same
 * composition, so every assertion above passes over ONE of them copied to both
 * names — measured. That would ship "the fire is still burning" on the screen
 * whose whole job is to say it is out, on both uninstaller pages, and nothing
 * would say so. The intent is the difference, so assert the difference.
 */
ok(
  'the two sidebars are not the same file',
  readFileSync(join(BUILD, 'installerSidebar.bmp')).compare(readFileSync(join(BUILD, 'uninstallerSidebar.bmp'))) !== 0
)
const litMean = MEAN_LUMA.get('installerSidebar.bmp') ?? 0
const outMean = MEAN_LUMA.get('uninstallerSidebar.bmp') ?? 0
ok(
  `the uninstaller sidebar is the dimmer of the two — the fire is out (${outMean.toFixed(1)} < ${litMean.toFixed(1)})`,
  outMean < litMean
)

/* ------------------------------------------------------------------ *
 * The dmg pair. `background@2x.png` is not configuration: dmg-builder
 * looks for `<name>@2x.<ext>` beside the background and merges the two
 * with `tiffutil -cathidpicheck`, then sizes the Finder WINDOW from the
 * @1x rep with `sips`. dmgbuild's window rect is in POINTS, so shipping
 * a lone 1080x760 gives a 1080x760-point window with no warning.
 * ------------------------------------------------------------------ */

function readPngSize(file: string): { magic: boolean; ihdr: string; width: number; height: number } {
  const b = readFileSync(join(BUILD, file))
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return {
    magic: b.subarray(0, 8).equals(sig),
    // The IHDR must be the first chunk; its length word sits at byte 8.
    ihdr: b.subarray(12, 16).toString('ascii'),
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
  }
}

console.log('\nthe dmg background and its retina sibling')
const bg = readPngSize('background.png')
const bg2x = readPngSize('background@2x.png')

ok('background.png: PNG signature', bg.magic)
check('background.png: IHDR is the first chunk', bg.ihdr, 'IHDR')
check('background.png: 540 wide, which becomes the Finder window width in POINTS', bg.width, 540)
check('background.png: 380 tall, likewise the height', bg.height, 380)

ok('background@2x.png: PNG signature', bg2x.magic)
check('background@2x.png: IHDR is the first chunk', bg2x.ihdr, 'IHDR')
check('background@2x.png: exactly twice the width', bg2x.width, bg.width * 2)
check('background@2x.png: exactly twice the height', bg2x.height, bg.height * 2)

/*
 * Everything above the line is a header read. A 540x380 PNG of nothing at all
 * passes all of it — measured, by encoding one and watching this suite print
 * `all pass` over it. The BMPs got four content assertions each and the dmg
 * background, which is the larger asset and the one asset whose whole pipeline
 * IS provable on this machine, had none. So decode the pixels.
 *
 * Pure Node, no dependency: inflate the IDATs and run PNG's five row filters
 * backwards. The suite runs on a CI box with no `sips`, so shelling out is not
 * an option, and adding an image library for two files is not one either.
 */
type Png = { width: number; height: number; channels: number; px: Buffer }

function decodePng(file: string): Png {
  const b = readFileSync(join(BUILD, file))
  let off = 8
  let width = 0
  let height = 0
  let depth = 0
  let colourType = 0
  const idat: Buffer[] = []
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off)
    const type = b.toString('ascii', off + 4, off + 8)
    const data = b.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colourType = data[9]
      if (data[12] !== 0) throw new Error(`${file}: interlaced PNGs are not decoded here`)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || (colourType !== 6 && colourType !== 2)) {
    throw new Error(`${file}: expected 8-bit RGB/RGBA, got depth ${depth} colour type ${colourType}`)
  }
  const channels = colourType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(stride * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = px.subarray(y * stride, (y + 1) * stride)
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const up = prev[i]
      const ul = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += up
      else if (filter === 3) v += (a + up) >> 1
      else if (filter === 4) {
        const guess = a + up - ul
        const da = Math.abs(guess - a)
        const db = Math.abs(guess - up)
        const dc = Math.abs(guess - ul)
        v += da <= db && da <= dc ? a : db <= dc ? up : ul
      }
      cur[i] = v & 0xff
    }
  }
  return { width, height, channels, px }
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function pngStats(p: Png) {
  let minAlpha = 255
  let peak = 0
  let sum = 0
  let warm = 0
  const colours = new Set<number>()
  for (let i = 0; i < p.px.length; i += p.channels) {
    const r = p.px[i]
    const g = p.px[i + 1]
    const b = p.px[i + 2]
    if (p.channels === 4 && p.px[i + 3] < minAlpha) minAlpha = p.px[i + 3]
    const L = luma(r, g, b)
    if (L > peak) peak = L
    sum += L
    if (r - b >= 24) warm++
    colours.add((r << 16) | (g << 8) | b)
  }
  const n = p.px.length / p.channels
  return { minAlpha, peak, mean: sum / n, warm, colours: colours.size, pixels: n }
}

/** Mean luma of each cell of a 6x4 grid, so two sizes of one picture compare. */
function grid(p: Png): number[] {
  const COLS = 6
  const ROWS = 4
  const out: number[] = []
  for (let ry = 0; ry < ROWS; ry++) {
    for (let rx = 0; rx < COLS; rx++) {
      const x0 = Math.floor((rx * p.width) / COLS)
      const x1 = Math.floor(((rx + 1) * p.width) / COLS)
      const y0 = Math.floor((ry * p.height) / ROWS)
      const y1 = Math.floor(((ry + 1) * p.height) / ROWS)
      let s = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * p.width + x) * p.channels
          s += luma(p.px[i], p.px[i + 1], p.px[i + 2])
          n++
        }
      }
      out.push(s / n)
    }
  }
  return out
}

const BG_PX = decodePng('background.png')
const BG2X_PX = decodePng('background@2x.png')

for (const [name, p] of [
  ['background.png', BG_PX],
  ['background@2x.png', BG2X_PX],
] as const) {
  const s = pngStats(p)
  ok(`${name}: more than 500 distinct colours (${s.colours})`, s.colours > 500)
  ok(`${name}: the fire is lit (peak luma ${s.peak.toFixed(1)} >= 180)`, s.peak >= 180)
  ok(`${name}: a warm region exists (${s.warm} pixels with R-B >= 24)`, s.warm > 2000)
  ok(`${name}: reads dark, like the app's own page (mean luma ${s.mean.toFixed(1)} < 70)`, s.mean < 70)
  /*
   * Finder composites this onto the window, so a partly transparent background
   * is a background with a lighter patch in it. The SVG paints an opaque page
   * rect; assert the raster kept it.
   */
  ok(`${name}: fully opaque (min alpha ${s.minAlpha})`, s.minAlpha === 255)
}

/*
 * And that the @2x is the SAME picture, not merely a PNG of twice the size —
 * the dimension check above passes just as happily over an unrelated image.
 * Compared as the mean luma of a 6x4 grid, which survives the resampling
 * difference between the two rasterisations and would not survive a different
 * drawing.
 */
const gridGap = Math.max(...grid(BG_PX).map((v, i) => Math.abs(v - grid(BG2X_PX)[i])))
ok(`background@2x.png: is the same picture as background.png (worst cell differs by ${gridGap.toFixed(2)} luma)`, gridGap < 3)

/* ------------------------------------------------------------------ *
 * Four hand-maintained lists that have to agree. CLAUDE.md gotcha 62:
 * two lists maintained by hand will diverge, including one whose own
 * comment tells you to keep it in step.
 * ------------------------------------------------------------------ */

const GENERATOR = readFileSync(join(ROOT, 'scripts', 'make-installer-art.cjs'), 'utf8')
const BUILDER_YML = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')

console.log('\nthe generator, the builder config and the committed files name the same art')
for (const name of ['installerSidebar.bmp', 'uninstallerSidebar.bmp', 'installerHeader.bmp']) {
  ok(`${name}: emitted by scripts/make-installer-art.cjs`, GENERATOR.includes(name))
  const key = name.replace('.bmp', '')
  ok(
    `${name}: named by electron-builder.yml's nsis.${key}`,
    new RegExp(`^\\s+${key}:\\s*build/${name.replace('.', '\\.')}\\s*$`, 'm').test(BUILDER_YML),
    'an unset key silently falls back to NSIS\'s stock nsis3-metro sidebar; a set one fails the build'
  )
}
ok('background.png: emitted by scripts/make-installer-art.cjs', GENERATOR.includes('background.png'))
ok('background@2x.png: emitted by scripts/make-installer-art.cjs', GENERATOR.includes('background@2x.png'))
ok(
  "background.png: named by electron-builder.yml's dmg.background",
  /^\s+background:\s*build\/background\.png\s*$/m.test(BUILDER_YML)
)

/*
 * The three "this key must stay absent" assertions below scan ONE top-level
 * block rather than the whole document, and they fail loudly if that block has
 * gone. Both halves matter. Scanning the whole file makes an unrelated
 * `script:` under some future section a false alarm, and locating the block
 * with `indexOf` and no check is worse: `''.slice(-1)` is a one-character
 * string that matches nothing, so deleting the `dmg:` block would have turned
 * the guard into a silent pass — a check that passes because it skipped.
 */
function ymlBlock(name: string): string | null {
  const lines = BUILDER_YML.split('\n')
  const start = lines.findIndex((l) => l === `${name}:`)
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end++
  return lines.slice(start + 1, end).join('\n')
}

const DMG_BLOCK = ymlBlock('dmg')
const NSIS_BLOCK = ymlBlock('nsis')
ok('electron-builder.yml still has a dmg: block to check', DMG_BLOCK !== null)
ok('electron-builder.yml still has an nsis: block to check', NSIS_BLOCK !== null)

/*
 * `dmg.window` and `dmg.background` are mutually exclusive in practice. In
 * dmg-builder 26.x the window is only read on the no-background branch, so
 * setting it alongside a background is not an override so much as a dead key
 * that reads like one — either way, a reader who sets both has been misled
 * about which one decides the window. Assert it stays unset.
 *
 * The test is `window:` in ANY form, not `window:` at end of line. YAML's flow
 * mapping — `window: { x: 100, y: 100, width: 900, height: 700 }`, which is how
 * the option is written in electron-builder's own docs and therefore how it
 * would arrive here — is exactly the shape the end-of-line version let through,
 * measured.
 */
ok('electron-builder.yml sets no dmg.window beside the background', !/^\s+window:/m.test(DMG_BLOCK ?? ''))

/*
 * `installerHeaderIcon` only reaches the script inside NsisTarget's
 * `if (oneClick)` branch, and oneClick is false here. Adding it would look like
 * branding and do nothing at all.
 */
ok('electron-builder.yml sets no inert nsis.installerHeaderIcon', !/^\s+installerHeaderIcon:/m.test(NSIS_BLOCK ?? ''))

/*
 * `nsis.script` replaces the whole generated script, which takes the
 * uninstaller's generation AND its signing with it.
 */
ok('electron-builder.yml sets no nsis.script', !/^\s+script:/m.test(NSIS_BLOCK ?? ''))

/* ------------------------------------------------------------------ *
 * One campfire, four SVGs. The alternative to this assertion is four
 * hand-copied path strings that drift until the header's flame is not
 * the sidebar's flame and nobody can say when that happened.
 * ------------------------------------------------------------------ */

const SVG_SOURCES = [
  'installerSidebar.svg',
  'uninstallerSidebar.svg',
  'installerHeader.svg',
  'background.svg',
] as const

/** The `d` of the one `<path id="...">` in a source, or null if it has none. */
function pathData(svg: string, id: string): string | null {
  const m = new RegExp(`<path id="${id}"[^>]*\\sd="([^"]*)"`).exec(svg)
  return m ? m[1] : null
}

const SOURCE_TEXT = new Map(SVG_SOURCES.map((f) => [f, readFileSync(join(BUILD, f), 'utf8')]))

console.log('\none campfire, shared across the four SVG sources')
for (const id of ['flame', 'core', 'logs', 'logs-lit']) {
  const seen = SVG_SOURCES.map((f) => ({ f, d: pathData(SOURCE_TEXT.get(f)!, id) })).filter((x) => x.d !== null)
  ok(`#${id}: at least two sources carry it (${seen.length})`, seen.length >= 2)
  const first = seen[0]
  for (const other of seen.slice(1)) {
    check(`#${id}: ${other.f} matches ${first.f} byte for byte`, other.d, first.d)
  }
}

/* ------------------------------------------------------------------ *
 * The committed rasters actually came from the committed SVGs.
 *
 * Everything else in this file reads the bitmaps alone, and a bitmap
 * cannot say which source it was drawn from — so editing an SVG and
 * forgetting `npm run art` left the OLD bytes in build/, `npm run
 * check` green, and the installer shipping last week's art. Measured:
 * recolouring every ember in uninstallerSidebar.svg changed nothing
 * any assertion here could see. The reviewable half of this pipeline
 * is the SVG and the shipped half is a binary nobody reads in a diff,
 * which is what makes that drift invisible from both ends.
 *
 * `npm run art` records a sha256 of each side in build/installer-art.json;
 * this recomputes them. Sources hash with CRLF folded to LF, so a
 * machine whose editor saves CRLF cannot fail a correct tree.
 * ------------------------------------------------------------------ */

type ArtManifest = { sources: Record<string, string>; outputs: Record<string, string> }
const MANIFEST: ArtManifest = JSON.parse(readFileSync(join(BUILD, 'installer-art.json'), 'utf8'))
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

console.log('\nthe committed bitmaps were generated from the committed SVGs')
check(
  'installer-art.json names every SVG source',
  Object.keys(MANIFEST.sources).sort(),
  [...SVG_SOURCES].sort()
)
check(
  'installer-art.json names every generated file',
  Object.keys(MANIFEST.outputs).sort(),
  ['background.png', 'background@2x.png', 'installerHeader.bmp', 'installerSidebar.bmp', 'uninstallerSidebar.bmp']
)
for (const [name, want] of Object.entries(MANIFEST.sources)) {
  ok(
    `${name}: unchanged since the last \`npm run art\``,
    sha256(Buffer.from(readFileSync(join(BUILD, name), 'utf8').replace(/\r\n/g, '\n'), 'utf8')) === want,
    'the source has moved and the committed bitmap has not — run `npm run art` and commit the result'
  )
}
for (const [name, want] of Object.entries(MANIFEST.outputs)) {
  ok(
    `${name}: is the file \`npm run art\` wrote`,
    sha256(readFileSync(join(BUILD, name))) === want,
    'this bitmap was edited by something other than the generator, or a regeneration was half-committed'
  )
}

/*
 * A `--` inside an XML comment is illegal, so the document is not well-formed,
 * the browser refuses to decode it, and the generator fails with a DOMException
 * that does not survive Electron's bridge — it reports `{}` and names nothing.
 * It has already cost one debugging round. Cheap to pin.
 */
console.log('\nthe SVG sources are well-formed enough to decode')
for (const f of SVG_SOURCES) {
  const text = SOURCE_TEXT.get(f)!
  const comments = text.match(/<!--[\s\S]*?-->/g) ?? []
  const bad = comments.filter((c) => c.slice(4, -3).includes('--'))
  ok(
    `${f}: no '--' inside an XML comment (${comments.length} comments)`,
    bad.length === 0,
    bad.length ? `offending comment starts: ${bad[0].slice(0, 60)}` : ''
  )
  check(`${f}: declares the SVG namespace`, /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(text), true)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
