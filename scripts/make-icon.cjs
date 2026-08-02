/**
 * Rasterises build/icon.svg to build/icon.png at 1024x1024.
 *
 * Run with `npm run icon`. electron-builder picks up build/icon.png and derives
 * the .ico and .icns it needs, so the SVG stays the single source of truth and
 * no binary needs hand-editing.
 *
 * Electron is used as the rasteriser because it is already a dev dependency —
 * this avoids pulling in sharp or a native image toolchain just for one asset.
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SVG_PATH = join(__dirname, '..', 'build', 'icon.svg')
const OUT_PATH = join(__dirname, '..', 'build', 'icon.png')
const SIZE = 1024

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = readFileSync(SVG_PATH, 'utf8')
  const win = new BrowserWindow({ show: false, width: 200, height: 200 })

  try {
    await win.loadURL('about:blank')

    // Drawing through a canvas rather than capturing the window keeps the
    // alpha channel intact, which the rounded corners depend on.
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg)};
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = ${SIZE};
      canvas.height = ${SIZE};
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, ${SIZE}, ${SIZE});
      ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE});
      return canvas.toDataURL('image/png');
    })()`)

    if (!dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`unexpected canvas output: ${dataUrl.slice(0, 40)}`)
    }

    const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
    writeFileSync(OUT_PATH, png)
    console.log(`wrote ${OUT_PATH} (${SIZE}x${SIZE}, ${png.length} bytes)`)
    app.exit(0)
  } catch (err) {
    console.error('icon generation failed:', err)
    app.exit(1)
  }
})
