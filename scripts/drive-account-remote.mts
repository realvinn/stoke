import { captureTestWindow } from './capture-test-window.mts'
/** Driven only by verify-account-remote with a throwaway account and loopback hub. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The page on a phone, with Chromium's own touch pipeline (CDP gestures, not
 * dispatched events). Owner, 2026-10-28, on the first day the site was live:
 * "I can't scroll and do much ... the back button what is that for". Every
 * check here failed on the build he used: the list did not scroll, a session
 * drew at its content height (composer mid-screen, under a keyboard), the
 * terminal's history did not move under a finger, the list's back link went
 * nowhere and the session's Back stacked a history entry.
 */
async function phone(win: BrowserWindow, run: (code: string) => Promise<any>, until: (code: string) => Promise<void>): Promise<void> {
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  const metrics = (height: number) => cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height, deviceScaleFactor: 3, mobile: true })
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await metrics(844)
  const swipe = (x: number, y: number, dy: number) => cdp.sendCommand('Input.synthesizeScrollGesture', { x, y, yDistance: dy, gestureSourceType: 'touch', speed: 1500 })
  const settle = () => new Promise(done => setTimeout(done, 400))
  await until(`document.querySelectorAll('.device-session[data-pty^="pty-pc"]').length === 12 && innerHeight === 844`)
  assert.equal(await run(`document.querySelectorAll('.devices-page .topbar a, .devices-page .topbar .icon-btn').length`), 0,
    'the computers list has no back control: the account site opens on it and nothing is behind it')
  const list = `document.querySelector('.devices-page main.scroll')`
  const box = await run(`({ client: ${list}.clientHeight, scroll: ${list}.scrollHeight, bottom: Math.round(${list}.getBoundingClientRect().bottom) })`)
  assert.ok(box.scroll > box.client && box.bottom === 844, `the list is a scroller bounded by the screen: ${JSON.stringify(box)}`)
  const last = `document.querySelector('.device-session[data-pty="pty-pc-12"]')`
  await swipe(195, 640, -1400); await settle(); await swipe(195, 640, -1400); await settle()
  const moved = await run(`({ top: ${list}.scrollTop, bar: Math.round(document.querySelector('.devices-page .topbar').getBoundingClientRect().top), page: scrollY, row: Math.round(${last}.getBoundingClientRect().bottom) })`)
  assert.ok(moved.top > 0 && moved.bar === 0 && moved.page === 0 && moved.row <= 844, `a finger scrolls the list under a fixed bar to its last session: ${JSON.stringify(moved)}`)
  const entries = await run('history.length')
  await run(`${last}.click()`)
  await until(`!!document.querySelector('.link-strip[hidden]') && /PC history \\d{3}/.test(document.querySelector('.xterm-rows')?.textContent ?? '')`)
  await settle()
  const fill = await run(`({ session: Math.round(document.querySelector('.session').getBoundingClientRect().bottom), dock: Math.round(document.querySelector('.dock').getBoundingClientRect().bottom) })`)
  assert.deepEqual(fill, { session: 844, dock: 844 }, 'a session fills the screen with its composer at the bottom')
  const firstRow = `Number(/PC history (\\d{3})/.exec(document.querySelector('.xterm-rows').textContent)?.[1] ?? 0)`
  const before = await run(firstRow)
  const at = await run(`(() => { const r = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: Math.round(r.left + 120), y: Math.round(r.top + 40) } })()`)
  await swipe(at.x, at.y, 300); await settle()
  const after = await run(firstRow)
  assert.ok(before > 0 && after > 0 && after < before, `a finger-down swipe over the terminal shows older history: line ${before} -> ${after}`)
  const back = await run(`(() => { const b = document.querySelector('.sbar .back-btn'); return { text: b.textContent.trim(), name: b.getAttribute('aria-label'), shown: b.getClientRects().length > 0 } })()`)
  assert.deepEqual(back, { text: 'Computers', name: 'Back to your computers', shown: true }, 'the session says where Back goes')
  // The on-screen keyboard, as Android resizes the content (interactive-widget=resizes-content).
  await run(`document.querySelector('.composer-input').focus()`)
  await metrics(470); await settle(); await settle()
  const typing = await run(`({ composer: Math.round(document.querySelector('.composer-input').getBoundingClientRect().bottom), session: Math.round(document.querySelector('.session').getBoundingClientRect().bottom), page: document.scrollingElement.scrollHeight })`)
  assert.ok(typing.composer <= 470 && typing.session === 470 && typing.page === 470, `with the keyboard up the composer stays above it: ${JSON.stringify(typing)}`)
  await run(`document.activeElement.blur()`)
  await metrics(844); await settle()
  await run(`document.querySelector('.sbar .back-btn').click()`)
  await until(`location.hash === '#/devices' && !!document.querySelector('.device-session[data-pty="pty-pc-12"]')`)
  assert.equal(await run('history.length'), entries + 1, 'Back returns to the list entry instead of stacking another')
  await run('history.back()')
  await new Promise(done => setTimeout(done, 600))
  assert.ok(!(await run('location.hash')).endsWith('/pty-pc-12'), 'the browser’s Back after it does not reopen the session just left')
  // The list reached with no hash at all (a bookmark, the address typed): Back
  // steps back to THAT entry. Replacing the session's entry with `#/devices`
  // left two list entries, so the browser's next Back redrew the same list.
  await run(`location.hash = ''`)
  await until(`location.hash === '' && !!${last}`)
  const bare = await run('history.length')
  const open = async (): Promise<void> => { await run(`${last}.click()`); await until(`!!document.querySelector('.sbar .back-btn')`) }
  await open()
  await run(`document.querySelector('.sbar .back-btn').click()`)
  await until(`!!document.querySelector('.devices-page')`)
  assert.deepEqual(await run(`({ hash: location.hash, entries: history.length })`), { hash: '', entries: bare + 1 },
    'Back from a session opened on the hash-less list returns to that entry, not a second list entry')
  // Two presses (or two "went offline" updates) before the step lands: two
  // history.back() calls go back two entries, past the list.
  await open()
  await run(`{ const b = document.querySelector('.sbar .back-btn'); b.click(); b.click() }`)
  await new Promise(done => setTimeout(done, 600))
  assert.equal(await run('location.hash'), '', 'Back pressed twice before it lands goes back once, never past the list')
  // A laptop browser: the account site has no rail to go back by, so its session keeps Back.
  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await until(`innerWidth === 1280`)
  await open()
  assert.equal(await run(`document.querySelector('.sbar .back-btn').getClientRects().length > 0`), true, 'at laptop width a session still shows Back')
  await run(`document.querySelector('.sbar .back-btn').click()`)
  await until(`!!document.querySelector('.devices-page')`)
  await cdp.sendCommand('Emulation.clearDeviceMetricsOverride')
  cdp.detach()
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let win: BrowserWindow | undefined
  let failed = false
  try {
    assert(process.env.STOKE_TEST_ACCOUNT_URL?.startsWith('http://127.0.0.1:'))
    win = new BrowserWindow({ width: 390, height: 844, show: process.platform === 'linux', webPreferences: { backgroundThrottling: false } })
    const errors: string[] = []
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
    const run = (code: string) => win!.webContents.executeJavaScript(code)
    const until = async (code: string): Promise<void> => {
      const end = Date.now() + 20000
      while (!(await run(code))) { assert(Date.now() < end, `Browser timed out: ${code}; ${await run('document.body.innerText')}`); await new Promise(done => setTimeout(done, 50)) }
    }
    await win.loadURL(process.env.STOKE_TEST_ACCOUNT_URL!)
    assert(!win.webContents.getURL().includes('connect='), 'QR credentials are removed from the address bar')
    await until(`!!document.querySelector('.device-session[data-pty="pty-pc"]')`)
    assert(await run(`!document.querySelector('.device-local')`), 'the account page has no laptop gateway card')
    writeFileSync(resolve('out/account-remote-devices.png'), (await captureTestWindow(win)).toPNG())
    await run(`document.querySelector('.device-session[data-pty="pty-pc"]').click()`)
    await until(`!!document.querySelector('.link-strip[hidden]') && !!document.querySelector('.composer-input:not(:disabled)')`)
    await run(`{const input=document.querySelector('.composer-input');input.value='browser UI input';input.dispatchEvent(new Event('input',{bubbles:true}))}`)
    await until(`!!document.querySelector('button[aria-label="Send"]:not(:disabled)')`)
    await run(`document.querySelector('button[aria-label="Send"]').click()`)
    await new Promise(done => setTimeout(done, 300))
    writeFileSync(resolve('out/account-remote-session.png'), (await captureTestWindow(win)).toPNG())
    const sessionHash = await run('location.hash')
    await run(`window.dispatchEvent(new Event('online'))`)
    await new Promise(done => setTimeout(done, 500))
    assert.equal(await run('location.hash'), sessionHash, 'a phone network reconnect does not switch sessions')
    await run(`{const input=document.querySelector('.composer-input');input.value='draft before browser sleep';input.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))}`)
    await until(`!!document.querySelector('.link-strip[hidden]') && document.querySelector('.composer-input')?.value==='draft before browser sleep'`)
    await run(`location.hash='#/devices'`)
    await until(`!!document.querySelector('.device-session[data-pty="pty-pc"]')`)
    await phone(win, run, until)
    assert.deepEqual(errors, [], 'no browser or CSP errors')
    console.log('PASS account remote browser: production page, credential scrubbing, independent computer list, terminal control, and back navigation; on a touch phone the list and the terminal history scroll, a session fills the screen above the keyboard, and Back says where it goes without stacking history.')
  } catch (error) { failed = true; console.error(error) }
  finally { win?.destroy(); app.exit(failed ? 1 : 0) }
}).catch(error => { console.error(error); app.exit(1) })
