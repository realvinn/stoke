import { app, type BrowserWindow } from 'electron'

// Xvfb has no hardware compositor. Use Chromium's software path before startup.
if (process.platform === 'linux') app.disableHardwareAcceleration()

/**
 * Bounded (gotcha 161): in a window that has stopped drawing, the frame wait
 * below never answers, and neither does `capturePage` (rehearsed on a Mac in a
 * hidden window with `paintWhenInitiallyHidden: false`: still waiting at 40 s).
 * ci-verify.mjs has no per-suite timeout, so an unbounded capture held a CI leg
 * until the job's own timeout instead of failing by name.
 */
export async function captureTestWindow(win: BrowserWindow, deadlineMs = 10_000): Promise<Electron.NativeImage> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(Object.assign(new Error(`no screenshot within ${deadlineMs / 1000} s: the window has stopped drawing (a requestAnimationFrame or capturePage never answered)`), { name: 'ScreenshotStalled' })), deadlineMs)
  })
  try { return await Promise.race([capture(win), stalled]) } finally { clearTimeout(timer) }
}

async function capture(win: BrowserWindow): Promise<Electron.NativeImage> {
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
