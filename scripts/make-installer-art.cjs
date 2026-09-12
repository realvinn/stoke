/**
 * Rasterises the four installer-art SVGs in build/ to the bitmaps the Windows
 * NSIS wizard and the macOS dmg actually read.
 *
 *   build/installerSidebar.svg   -> build/installerSidebar.bmp    164x314, 24-bit
 *   build/uninstallerSidebar.svg -> build/uninstallerSidebar.bmp  164x314, 24-bit
 *   build/installerHeader.svg    -> build/installerHeader.bmp      150x57, 24-bit
 *   build/background.svg         -> build/background.png            540x380
 *                                -> build/background@2x.png        1080x760
 *
 * Run with `npm run art`. The outputs are committed, exactly as build/icon.png
 * is, so a release runner never has to rasterise anything. `npm run check` does
 * not run this script; it runs `verify:installer-art` over its committed output.
 *
 * Electron is the rasteriser for the same reason scripts/make-icon.cjs uses it:
 * it is already a dev dependency, so no image toolchain is pulled in for five
 * files. This script is that one's trick plus a hand-written BMP encoder.
 *
 * WHY THE BMPs ARE WRITTEN BY HAND
 *
 * Chromium's canvas encodes png, jpeg and webp and nothing else, so `toDataURL`
 * cannot produce a BMP at all. And the BMP has to be a very specific BMP: NSIS
 * loads these through the Win32 LoadImage, which only understands the classic
 * 40-byte BITMAPINFOHEADER -- "BMP3" / "Windows 3.x" in file(1)'s words. The
 * BITMAPV4HEADER/BITMAPV5HEADER that ImageMagick, Photoshop and "Windows
 * 98/2000 and newer" write by default are NOT displayed. So the header is
 * assembled here rather than delegated, and the fields that matter carry
 * comments.
 *
 * WHY THE ALPHA IS COMPOSITED HERE
 *
 * BMP3 has no alpha channel, and NSIS ignores alpha even in a 32-bit BMP, so
 * anything left transparent arrives as whatever happens to be in the RGB bytes
 * -- usually black. Each asset therefore names the solid colour its own art
 * sits on and is flattened onto it before encoding.
 *
 * WHAT NOBODY VALIDATES
 *
 * electron-builder does not check these files at all: no magic bytes, no
 * dimensions, no bit depth (its nsisValidation only greps makensis stderr for
 * /^Error:/ lines and compares the installer's size to its payload). A
 * wrong-format bitmap makes makensis emit a WARNING, renders blank or as
 * garbage, and exits 0 -- a broken installer through a green build, which is
 * CLAUDE.md gotcha 62's exact shape. That is what scripts/verify-installer-art.mts
 * exists for, and why it was written in the same change as this script.
 *
 * UNVERIFIED: that these bitmaps render correctly in a real NSIS wizard. Every
 * format claim here is read out of the shipped app-builder-lib templates and
 * measured with file(1)/sips on macOS. No round of work in this repo has run on
 * Windows.
 */
const { app, BrowserWindow } = require('electron')
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync, writeSync } = require('node:fs')
const { join } = require('node:path')

const BUILD_DIR = join(__dirname, '..', 'build')

/**
 * The manifest is what ties a committed raster to the SVG it came from.
 *
 * Without it the two halves of this pipeline are a hand-maintained pair that
 * cannot disagree loudly: editing a .svg and forgetting `npm run art` leaves
 * the OLD bitmap in build/ and every gate green, because verify:installer-art
 * can only see that the bytes on disk are a well-formed BMP -- which they are,
 * they are just last week's. The reviewable half is the SVG and the shipped
 * half is a binary nobody reads in a diff, so the drift is invisible from both
 * ends. That is CLAUDE.md gotcha 62's "two lists maintained by hand" one level
 * down, and it was reachable: measured by recolouring every ember in
 * uninstallerSidebar.svg, skipping this script, and watching the suite pass.
 *
 * So every run records what it read and what it wrote, and the suite recomputes
 * both. Sources are hashed with newlines normalised: .gitattributes checks this
 * tree out `eol=lf`, but an editor that saves CRLF before the commit would
 * otherwise turn a correct tree red on one machine only.
 */
const MANIFEST = 'installer-art.json'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const hashSource = (text) => sha256(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8'))

/**
 * `flatten` is the colour the asset's own art is drawn on, so a transparent
 * pixel lands on the right thing rather than on black.
 */
const ASSETS = [
  { svg: 'installerSidebar.svg', out: 'installerSidebar.bmp', w: 164, h: 314, kind: 'bmp', flatten: '#0d0b0a' },
  { svg: 'uninstallerSidebar.svg', out: 'uninstallerSidebar.bmp', w: 164, h: 314, kind: 'bmp', flatten: '#0d0b0a' },
  { svg: 'installerHeader.svg', out: 'installerHeader.bmp', w: 150, h: 57, kind: 'bmp', flatten: '#ffffff' },
  { svg: 'background.svg', out: 'background.png', w: 540, h: 380, kind: 'png', scale: 1 },
  { svg: 'background.svg', out: 'background@2x.png', w: 540, h: 380, kind: 'png', scale: 2 },
]

function parseHex(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

/**
 * A 24-bit, uncompressed, bottom-up BMP with the 40-byte BITMAPINFOHEADER.
 * Every one of those four words is load-bearing; see the header comment.
 */
function encodeBmp24(rgba, width, height, flattenHex) {
  const bg = parseHex(flattenHex)
  // Each row is padded up to a 4-byte boundary. This is the single most common
  // way to get a BMP that decodes as a sheared image.
  const rowSize = (width * 3 + 3) & ~3
  const pixelBytes = rowSize * height
  const out = Buffer.alloc(54 + pixelBytes)

  // BITMAPFILEHEADER, 14 bytes.
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(54 + pixelBytes, 2) // bfSize
  out.writeUInt32LE(0, 6) // bfReserved1/2
  out.writeUInt32LE(54, 10) // bfOffBits: pixels start straight after the two headers

  // BITMAPINFOHEADER, 40 bytes. 40 is the whole point: see the header comment.
  out.writeUInt32LE(40, 14) // biSize
  out.writeInt32LE(width, 18) // biWidth
  out.writeInt32LE(height, 22) // biHeight, POSITIVE => rows stored bottom-up
  out.writeUInt16LE(1, 26) // biPlanes
  out.writeUInt16LE(24, 28) // biBitCount: 24-bit RGB, no alpha
  out.writeUInt32LE(0, 30) // biCompression: BI_RGB
  out.writeUInt32LE(pixelBytes, 34) // biSizeImage
  out.writeInt32LE(2835, 38) // biXPelsPerMeter, 72 dpi
  out.writeInt32LE(2835, 42) // biYPelsPerMeter
  out.writeUInt32LE(0, 46) // biClrUsed
  out.writeUInt32LE(0, 50) // biClrImportant

  for (let y = 0; y < height; y++) {
    // Row 0 of the file is the BOTTOM row of the image.
    const srcRow = (height - 1 - y) * width * 4
    let d = 54 + y * rowSize
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4
      const a = rgba[s + 3] / 255
      // Channels go out as BGR, not RGB.
      out[d++] = Math.round(rgba[s + 2] * a + bg.b * (1 - a))
      out[d++] = Math.round(rgba[s + 1] * a + bg.g * (1 - a))
      out[d++] = Math.round(rgba[s + 0] * a + bg.r * (1 - a))
    }
  }
  return out
}

/**
 * Draws one SVG into a canvas of the given pixel size and hands back either the
 * raw RGBA bytes (for the BMP path) or a PNG.
 *
 * The page code is assembled from an array of lines rather than one long
 * template literal, per CLAUDE.md's standing trap: a nested backtick ends the
 * outer template early and reports the SyntaxError in the wrong place.
 */
async function draw(win, svg, width, height, want) {
  const lines = [
    '(async () => {',
    '  try {',
    '  const svg = ' + JSON.stringify(svg) + ';',
    '  const img = new Image();',
    "  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);",
    '  await img.decode();',
    "  const canvas = document.createElement('canvas');",
    '  canvas.width = ' + width + ';',
    '  canvas.height = ' + height + ';',
    "  const ctx = canvas.getContext('2d', { willReadFrequently: true });",
    '  ctx.clearRect(0, 0, ' + width + ', ' + height + ');',
    '  ctx.drawImage(img, 0, 0, ' + width + ', ' + height + ');',
    '  if (' + JSON.stringify(want) + " === 'png') {",
    "    return { ok: true, value: canvas.toDataURL('image/png') };",
    '  }',
    '  const d = ctx.getImageData(0, 0, ' + width + ', ' + height + ').data;',
    "  let s = '';",
    '  const CHUNK = 0x8000;',
    '  for (let i = 0; i < d.length; i += CHUNK) {',
    '    s += String.fromCharCode.apply(null, d.subarray(i, i + CHUNK));',
    '  }',
    '  return { ok: true, value: btoa(s) };',
    '  } catch (e) {',
    "    return { ok: false, error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) };",
    '  }',
    '})()',
  ]
  // The page's own errors are caught and returned as data rather than left to
  // reject: a rejected executeJavaScript arrives in main with no message and no
  // stack, so the whole run reports `{}` and names nothing. The way to produce
  // that, for the record, is a `--` inside an XML comment in one of the SVGs.
  // It is illegal there, so the document is not well-formed, `img.decode()`
  // rejects with a DOMException, and the DOMException does not survive the
  // bridge. It cost a debugging round the first time.
  const res = await win.webContents.executeJavaScript(lines.join('\n'))
  if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'the page returned nothing')
  return res.value
}

/** Adds the asset's own name to whatever `draw` threw, so the report names a file. */
function named(out, err) {
  return new Error(`${out}: ${(err && err.message) || err}`)
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 })
  const report = []
  const sources = {}
  const outputs = {}

  try {
    await win.loadURL('about:blank')

    for (const asset of ASSETS) {
      const svg = readFileSync(join(BUILD_DIR, asset.svg), 'utf8')
      sources[asset.svg] = hashSource(svg)
      const outPath = join(BUILD_DIR, asset.out)

      if (asset.kind === 'bmp') {
        const b64 = await draw(win, svg, asset.w, asset.h, 'rgba').catch((e) => {
          throw named(asset.svg, e)
        })
        const rgba = Buffer.from(b64, 'base64')
        if (rgba.length !== asset.w * asset.h * 4) {
          throw new Error(`${asset.out}: got ${rgba.length} bytes of RGBA, expected ${asset.w * asset.h * 4}`)
        }
        const bmp = encodeBmp24(rgba, asset.w, asset.h, asset.flatten)
        writeFileSync(outPath, bmp)
        outputs[asset.out] = sha256(bmp)
        report.push(`wrote ${outPath} (${asset.w}x${asset.h} BMP3 24-bit, ${bmp.length} bytes)`)
      } else {
        const width = asset.w * asset.scale
        const height = asset.h * asset.scale
        const dataUrl = await draw(win, svg, width, height, 'png').catch((e) => {
          throw named(asset.svg, e)
        })
        const prefix = 'data:image/png;base64,'
        if (!dataUrl.startsWith(prefix)) {
          throw new Error(`${asset.out}: unexpected canvas output: ${String(dataUrl).slice(0, 40)}`)
        }
        const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
        writeFileSync(outPath, png)
        outputs[asset.out] = sha256(png)
        report.push(`wrote ${outPath} (${width}x${height} PNG, ${png.length} bytes)`)
      }
    }

    const manifestPath = join(BUILD_DIR, MANIFEST)
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          note:
            'Written by `npm run art`. verify:installer-art recomputes these, so an SVG ' +
            'edited without regenerating fails the check instead of silently shipping the ' +
            'previous bitmap. Sources are hashed with CRLF normalised to LF.',
          sources,
          outputs,
        },
        null,
        2
      ) + '\n'
    )
    report.push(`wrote ${manifestPath} (${Object.keys(sources).length} sources, ${Object.keys(outputs).length} outputs)`)

    // writeSync rather than console.log: app.exit() does not flush a piped
    // stdout, so a line printed just before it can simply never arrive.
    writeSync(1, report.join('\n') + '\n')
    app.exit(0)
  } catch (err) {
    const why = (err && err.stack) || (err && err.message) || JSON.stringify(err)
    writeSync(2, `installer art generation failed: ${why}\n`)
    app.exit(1)
  }
})
