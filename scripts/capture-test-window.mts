import { app, type BrowserWindow } from 'electron'

// Xvfb has no hardware compositor. Use Chromium's software path before startup.
if (process.platform === 'linux') app.disableHardwareAcceleration()

export async function captureTestWindow(win: BrowserWindow): Promise<Electron.NativeImage> {
  // DOM mutations can reach the test before Viz has submitted the first frame.
  await win.webContents.executeJavaScript('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))')
  for (let attempt = 0; ; attempt++) {
    try {
      const image = await win.webContents.capturePage()
      if (image.isEmpty()) throw new Error('Empty test screenshot')
      return image
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise(done => setTimeout(done, 150))
    }
  }
}
