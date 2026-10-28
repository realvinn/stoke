import { captureTestWindow } from './capture-test-window.mts'
import { touchDrag } from './touch-drag.mts'
/** Driven only by verify-account-remote with a throwaway account and loopback hub. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Set while the driver keeps the hub away on purpose: the page's own 503 logs are then expected. */
let hubAway = false

type Run = (code: string) => Promise<any>
type Until = (code: string) => Promise<void>
type Debugger = BrowserWindow['webContents']['debugger']
const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
async function untilTrue(what: string, test: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) { assert(Date.now() < end, `Timed out: ${what}`); await pause(50) }
}
/** verify-account-remote's switches for the hub as the page reaches it (`hold`, `fail`, `open`) and for PC (`offline`, `chain`). */
const hub = async (path: string): Promise<void> => { const r = await fetch(`${new URL(process.env.STOKE_TEST_ACCOUNT_URL!).origin}/__test/${path}`); assert.ok(r.ok, `the test switch ${path} answered ${r.status} ${await r.text()}`) }

/**
 * The computers list through every presence re-check, at phone size and
 * scrolled to its end. Presence re-checks on each return to the tab and each
 * 'online' (a wake), and when another browser on the same link takes the
 * presence socket (the hub keeps one per device). The page called the list
 * unavailable until presence answered, and the list read that as no
 * computers: it removed every card, and a scrolled list landed at its top
 * (1202 -> 0 in Chromium and WebKit, 2026-10-28). Each case counts the cards
 * removed, and the scroller's lowest and highest place and the last row's
 * place inside it every 10 ms, and waits for the re-check's new presence
 * socket before an absence counts.
 */
async function keepsTheList(cdp: Debugger, run: Run, until: Until, top: number): Promise<void> {
  let presence = 0
  cdp.on('message', (_event, method, params) => { if (method === 'Network.webSocketCreated' && String(params?.url).includes('/v1/ws/presence')) presence++ })
  await cdp.sendCommand('Network.enable')
  await run(`(() => {
    const L = window.__list = { removed: 0, low: Infinity, high: -Infinity, rowLow: Infinity, rowHigh: -Infinity }
    new MutationObserver(records => { for (const r of records) for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches('.device-card') || n.querySelector('.device-card'))) L.removed++ })
      .observe(document.querySelector('#app'), { childList: true, subtree: true })
    // The scroller's place, and the last row's place inside it: a note shown above it moves it without a scroll.
    // Read on a timer, not a frame: a hidden window can draw almost none (gotcha 161), and a read lays out anyway.
    setInterval(() => {
      const s = document.querySelector('.devices-page main.scroll'), row = document.querySelector('.device-session[data-pty="pty-pc-12"]')
      if (s) { L.low = Math.min(L.low, s.scrollTop); L.high = Math.max(L.high, s.scrollTop) }
      if (s && row) { const at = row.getBoundingClientRect().top - s.getBoundingClientRect().top; L.rowLow = Math.min(L.rowLow, at); L.rowHigh = Math.max(L.rowHigh, at) }
    }, 10)
  })()`)
  /** What the list did since the last read: cards removed, its lowest and highest place, and now. */
  const read = (): Promise<{ removed: number; low: number; high: number; top: number; rowLow: number; rowHigh: number; cards: number; held: number; said: string; note: string }> => run(`(() => {
    const L = window.__list, s = document.querySelector('.devices-page main.scroll'), n = document.querySelector('.account-notice')
    const r = { removed: L.removed, low: Math.round(L.low), high: Math.round(L.high), top: Math.round(s.scrollTop), rowLow: Math.round(L.rowLow), rowHigh: Math.round(L.rowHigh), cards: document.querySelectorAll('.device-card').length,
      held: document.querySelectorAll('.device-session:not([href])').length,
      said: [...document.querySelectorAll('.devices-content > p.device-note')].filter(p => !p.hidden).map(p => p.textContent).join(' '),
      note: n.hidden ? '' : n.textContent }
    Object.assign(L, { removed: 0, low: Infinity, high: -Infinity, rowLow: Infinity, rowHigh: -Infinity })
    return r
  })()`)
  const live = `document.querySelectorAll('.device-session[data-pty^="pty-pc"][href]').length === 12`
  await pause(200)
  const place = (await read()).rowHigh
  assert.ok(Number.isFinite(place), `the last row has a place in the list to keep: ${place}`)
  /** Every card there all along, the scroller where it was, and the last row where it was inside it. */
  const kept = (r: Awaited<ReturnType<typeof read>>): boolean => r.removed === 0 && r.cards === 1 && r.low === top && r.high === top && r.top === top && r.rowLow === place && r.rowHigh === place
  for (const [what, wake] of [['back to the tab', `document.dispatchEvent(new Event('visibilitychange'))`], ['the network back', `window.dispatchEvent(new Event('online'))`]]) {
    await read(); const before = presence
    await run(wake)
    await untilTrue(`a wake (${what}) opens a new presence socket`, () => presence > before)
    await until(live)
    const r = await read()
    assert.ok(kept(r) && r.note === '', `${what}: presence re-checks and the list keeps its card where it was: ${JSON.stringify(r)}`)
  }
  // A slow hub: the re-check lasts as long as it takes, and nothing on the list moves meanwhile.
  await read(); let before = presence
  await hub('hub?mode=hold')
  await run(`document.dispatchEvent(new Event('visibilitychange'))`)
  await pause(600)
  const slow = await read()
  assert.ok(kept(slow) && slow.held === 12 && slow.said === '' && slow.note === '', `while presence re-checks (a slow hub) the card stays where it was, its links held, nothing said: ${JSON.stringify(slow)}`)
  await hub('hub?mode=open')
  await untilTrue('the held re-check opens a presence socket', () => presence > before)
  await until(live)
  const answered = await read()
  assert.ok(kept(answered), `and once presence answers the list is live where it was: ${JSON.stringify(answered)}`)
  // The hub away: the re-check fails and says so, the card stays with its links held, and presence comes back by itself.
  await read(); before = presence
  hubAway = true
  await hub('hub?mode=fail')
  await run(`document.dispatchEvent(new Event('visibilitychange'))`)
  await until(`!document.querySelector('.account-notice').hidden`)
  const away = await read()
  assert.ok(kept(away) && away.held === 12 && /503/.test(away.note), `the hub away: the failure is said, the card kept with its links held: ${JSON.stringify(away)}`)
  await hub('hub?mode=open')
  await untilTrue('presence comes back by itself once the hub does (a failed wake left it stopped)', () => presence > before)
  await until(`${live} && document.querySelector('.account-notice').hidden`)
  hubAway = false
  const recovered = await read()
  assert.ok(kept(recovered), `and with the hub back the list is live where it was and the failure note gone: ${JSON.stringify(recovered)}`)
  // Another browser on the same link: the hub hands the one presence socket to whichever opened last, so the two take turns.
  await read(); before = presence
  const second = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  try {
    await second.loadURL(process.env.STOKE_TEST_ACCOUNT_URL!)
    await untilTrue('another browser on the same link takes the socket and this one takes it back, twice', () => presence >= before + 2, 20000)
  } finally { second.destroy() }
  await until(live)
  const turns = await read()
  assert.ok(kept(turns) && turns.note === '', `another browser on the same link: the list keeps its card where it was through ${presence - before} turns: ${JSON.stringify(turns)}`)
  // One read failing while presence stays up (the 10 s pass; here the read a `chain` frame starts):
  // the failure is said, and the next read that succeeds takes it away. Only a presence frame
  // cleared it, so "did not answer" stayed over a live list, pushed down under it, until some
  // device came or went (2026-10-28: still up 25 s after the hub answered, two reads later).
  await read(); before = presence
  hubAway = true
  await hub('hub?mode=fail')
  await hub('chain')
  await until(`!document.querySelector('.account-notice').hidden`)
  const failedRead = await read()
  await hub('hub?mode=open')
  await hub('chain')
  const clearBy = Date.now() + 8000
  while (!(await run(`document.querySelector('.account-notice').hidden`))) {
    assert.ok(Date.now() < clearBy, `once a read succeeds again the failure note goes, presence up all along: ${JSON.stringify({ failedRead, now: await read(), reconnects: presence - before })}`)
    await pause(50)
  }
  hubAway = false
  const readAgain = await read()
  assert.ok(presence === before && /503/.test(failedRead.note) && failedRead.held === 0 && kept(failedRead) && kept(readAgain) && readAgain.held === 0,
    `a failed read with presence up: said over a list that stayed live, then gone with no reconnect: ${JSON.stringify({ failedRead, readAgain, reconnects: presence - before })}`)
}

/**
 * The key row's toggle and a key sent on click, tapped (trusted touch) with
 * the composer focused. Each keeps the composer's focus by cancelling its
 * mousedown, fires its click, and leaves its pointerdown alone: WebKit drops
 * a tap's click when the pointerdown was cancelled (in WebKit 26.6 the toggle
 * and every key sent on click did nothing), though Chromium fires it anyway,
 * so here the rule is read off the events.
 */
async function tapsKeepFocus(cdp: Debugger, run: Run): Promise<void> {
  await run(`(() => { window.__taps = []; for (const type of ['pointerdown', 'mousedown', 'click']) window.addEventListener(type, e => { if (e.target.closest && e.target.closest('.keys-toggle, .keys button')) window.__taps.push(type + (e.defaultPrevented ? ' cancelled' : '')) }) })()`)
  // On macOS the window is hidden, so it has no system focus and Chromium holds focus events back; a
  // focused page is emulated for these taps instead (nothing is shown over the owner's work).
  await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await run(`document.querySelector('.composer-input').focus()`)
  await pause(400)
  const state = `({ taps: window.__taps.splice(0), row: !document.querySelector('.keys').hidden, focused: document.activeElement === document.querySelector('.composer-input') })`
  assert.deepEqual(await run(state), { taps: [], row: true, focused: true }, 'typing brings the key row out')
  const tap = async (selector: string): Promise<{ taps: string[]; row: boolean; focused: boolean }> => {
    const at = await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    // A tap's halves sent together, both replies awaited: one after the other's reply, they reach the page 2 s apart on
    // the Linux runner, a press rather than a tap (gotcha 180).
    await Promise.all([
      cdp.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] }),
      cdp.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    ])
    await pause(400)
    return run(state)
  }
  const rule = ['pointerdown', 'mousedown cancelled', 'click']
  assert.deepEqual(await tap('.keys-toggle'), { taps: rule, row: false, focused: true }, 'a tap on Terminal keys folds the row and keeps the composer focused, its pointerdown left alone')
  assert.deepEqual(await tap('.keys-toggle'), { taps: rule, row: true, focused: true }, 'and a second tap brings it back')
  assert.deepEqual(await tap('.keys [data-key="Escape"]'), { taps: rule, row: true, focused: true }, 'a tap on Esc keeps the composer focused, its pointerdown left alone (the key reaching PC is checked by verify-account-remote)')
  await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
}

/** A computer that went offline while presence re-checked shows as offline once it answers. */
async function goneOffline(run: Run, until: Until): Promise<void> {
  await hub('hub?mode=hold')
  await run(`document.dispatchEvent(new Event('visibilitychange'))`)
  await pause(400)
  const held = await run(`({ cards: document.querySelectorAll('.device-card').length, held: document.querySelectorAll('.device-session:not([href])').length })`)
  await hub('offline')
  await pause(300)
  await hub('hub?mode=open')
  await until(`!document.querySelector('.device-card') && /None of your other devices is online/.test(document.querySelector('.devices-content').textContent)`)
  assert.deepEqual(held, { cards: 1, held: 12 }, 'while presence re-checks the computer is kept, its links held')
}

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
  /*
   * Emulate a screen, then wait until the page's LAYOUT has it (gotcha 182). innerHeight takes the
   * override at once; an element already laid out in viewport units keeps its old size until a later
   * frame. On a macOS runner (2026-10-28) the list still ended at the window's real 816 px when
   * innerHeight already said 844, and reached 844 27 ms later, so "bounded by the screen" failed on
   * every runner whose real window is shorter than the phone (macOS 816, Windows 655) and passed under
   * xvfb, whose window is the full 844. The wait is on a 100dvw x 100dvh probe of the suite's own, made
   * and laid out BEFORE the override like the page's own elements: one made after it is laid out fresh,
   * at the new size at once, and proves nothing (the first cut of this wait did exactly that).
   */
  const probe = 'suite-viewport-probe'
  const screenIs = async (width: number, height: number, mobile = true): Promise<void> => {
    await run(`(() => {
      let p = document.getElementById('${probe}')
      if (!p) {
        p = document.createElement('div')
        p.id = '${probe}'
        Object.assign(p.style, { position: 'fixed', top: '0', left: '0', width: '100dvw', height: '100dvh', visibility: 'hidden', pointerEvents: 'none' })
        document.body.append(p)
      }
      return p.getBoundingClientRect().height
    })()`)
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile })
    await until(`(() => {
      const r = document.getElementById('${probe}')?.getBoundingClientRect()
      return !!r && innerWidth === ${width} && innerHeight === ${height} && Math.round(r.width) === ${width} && Math.round(r.height) === ${height}
    })()`)
  }
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await screenIs(390, 844)
  // A finger drag as dispatched touches; synthesizeScrollGesture's touch source sends no touchmove on Linux (gotcha 180).
  const swipe = (x: number, y: number, dy: number) => touchDrag((method, params) => cdp.sendCommand(method, params), x, y, dy)
  const settle = () => new Promise(done => setTimeout(done, 400))
  await until(`document.querySelectorAll('.device-session[data-pty^="pty-pc"]').length === 12`)
  assert.equal(await run(`document.querySelectorAll('.devices-page .topbar a, .devices-page .topbar .icon-btn').length`), 0,
    'the computers list has no back control: the account site opens on it and nothing is behind it')
  const list = `document.querySelector('.devices-page main.scroll')`
  const box = await run(`({ client: ${list}.clientHeight, scroll: ${list}.scrollHeight, bottom: Math.round(${list}.getBoundingClientRect().bottom) })`)
  assert.ok(box.scroll > box.client && box.bottom === 844, `the list is a scroller bounded by the screen: ${JSON.stringify(box)}`)
  const last = `document.querySelector('.device-session[data-pty="pty-pc-12"]')`
  await swipe(195, 760, -660); await settle(); await swipe(195, 760, -660); await settle()
  const moved = await run(`({ top: ${list}.scrollTop, bar: Math.round(document.querySelector('.devices-page .topbar').getBoundingClientRect().top), page: scrollY, row: Math.round(${last}.getBoundingClientRect().bottom) })`)
  assert.ok(moved.top > 0 && moved.bar === 0 && moved.page === 0 && moved.row <= 844, `a finger scrolls the list under a fixed bar to its last session: ${JSON.stringify(moved)}`)
  await keepsTheList(cdp, run, until, Math.round(moved.top))
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
  await tapsKeepFocus(cdp, run)
  // The on-screen keyboard, as Android resizes the content (interactive-widget=resizes-content).
  await run(`document.querySelector('.composer-input').focus()`)
  await screenIs(390, 470); await settle(); await settle()
  const typing = await run(`({ composer: Math.round(document.querySelector('.composer-input').getBoundingClientRect().bottom), session: Math.round(document.querySelector('.session').getBoundingClientRect().bottom), page: document.scrollingElement.scrollHeight })`)
  assert.ok(typing.composer <= 470 && typing.session === 470 && typing.page === 470, `with the keyboard up the composer stays above it: ${JSON.stringify(typing)}`)
  await run(`document.activeElement.blur()`)
  await screenIs(390, 844); await settle()
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
  await screenIs(1280, 800, false)
  await open()
  assert.equal(await run(`document.querySelector('.sbar .back-btn').getClientRects().length > 0`), true, 'at laptop width a session still shows Back')
  await run(`document.querySelector('.sbar .back-btn').click()`)
  await until(`!!document.querySelector('.devices-page')`)
  await goneOffline(run, until)
  await cdp.sendCommand('Emulation.clearDeviceMetricsOverride')
  cdp.detach()
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let win: BrowserWindow | undefined
  let failed = false
  try {
    assert(process.env.STOKE_TEST_ACCOUNT_URL?.startsWith('http://127.0.0.1:'))
    /*
     * Shown everywhere but macOS (gotcha 183). On the windows-latest runner each touch dispatched into a
     * HIDDEN window answered after ~1 s (3 s over the terminal), so the phone checks took ~160 s and the
     * suite's 60 s limit killed this drive mid-swipe; shown, the same checks took 16 s with no call over
     * 300 ms. A hidden macOS window takes them at once, so the Mac keeps its window out of the owner's way.
     */
    win = new BrowserWindow({ width: 390, height: 844, show: process.platform !== 'darwin', webPreferences: { backgroundThrottling: false } })
    const errors: string[] = []
    // The page logs each 503 it gets while the driver keeps the hub away on purpose (`hubAway`).
    win.webContents.on('console-message', event => { if (event.level === 'error' && !(hubAway && /status of 503/.test(event.message))) errors.push(event.message) })
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
    console.log('PASS account remote browser: production page, credential scrubbing, independent computer list, terminal control, and back navigation; on a touch phone the list and the terminal history scroll, a session fills the screen above the keyboard, and Back says where it goes without stacking history; the computers list keeps its cards and its place through every presence re-check (a wake, a slow or absent hub, another browser on the same link) and drops a computer only once presence says it went offline; a read that fails while presence stays up is said, and gone with the next read that succeeds; the key row’s toggle and Esc keep the composer focused without cancelling their pointerdown.')
  } catch (error) { failed = true; console.error(error) }
  finally { win?.destroy(); app.exit(failed ? 1 : 0) }
}).catch(error => { console.error(error); app.exit(1) })
