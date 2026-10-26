import { captureTestWindow } from './capture-test-window.mts'
/** Driven only by verify-account-remote with a throwaway account and loopback hub. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
    assert.deepEqual(errors, [], 'no browser or CSP errors')
    console.log('PASS account remote browser: production page, credential scrubbing, independent computer list, terminal control, and back navigation.')
  } catch (error) { failed = true; console.error(error) }
  finally { win?.destroy(); app.exit(failed ? 1 : 0) }
}).catch(error => { console.error(error); app.exit(1) })
