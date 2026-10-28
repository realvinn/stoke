/** Exercise shipped touch routing with real xterm mouse reporting in Chromium. */
import { touchDrag } from './touch-drag.mts'
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/phone-scroll-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.ts')
    writeFileSync(entry, `
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { mountTerminalTouchScroll } from ${JSON.stringify(resolve('src/remote/terminalTouchScroll.ts'))};
import { mountTerminalKeys, EOF_CONFIRM_MS } from ${JSON.stringify(resolve('src/remote/terminalKeyBar.ts'))};
const root = document.getElementById('terminal'), input = document.getElementById('composer');
const term = new Terminal({cols:40,rows:10}); term.open(root);
const abort = new AbortController(); let allowed = true, forwarding = false; const data = [];
term.onData(value => { if (forwarding) data.push(value); });
mountTerminalTouchScroll(root, { enabled: () => allowed && term.modes.mouseTrackingMode !== 'none' && term.modes.mouseTrackingMode !== 'x10', lineHeight: () => 20, signal: abort.signal,
 wheel: (x,y,delta) => {forwarding = true; try {root.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel',{deltaMode:WheelEvent.DOM_DELTA_LINE,deltaY:Math.sign(delta),clientX:x,clientY:y,bubbles:true,cancelable:true}));} finally {forwarding=false;}}
});
const write = value => new Promise(done => term.write(value,done));
const touch = (type,x,y,multi=false) => {
 const first = new Touch({identifier:1,target:root,clientX:x,clientY:y});
 const touches = multi ? [first,new Touch({identifier:2,target:root,clientX:x+10,clientY:y})] : [first];
 return root.dispatchEvent(new TouchEvent(type,{touches,targetTouches:touches,changedTouches:touches,bubbles:true,cancelable:true}));
};
window.exercise = async () => {
 await write('hello\\r\\nworld\\x1b[?1000h\\x1b[?1006h'); input.focus();
 const rect=root.querySelector('.xterm-screen').getBoundingClientRect(), x=rect.left+20, y=rect.top+40;
 touch('touchstart',x,y); const consumed = !touch('touchmove',x,y+60); const older = data.splice(0);
 touch('touchstart',x,y+60); touch('touchmove',x,y); const newer = data.splice(0);
 touch('touchstart',x,y); const horizontalNative = touch('touchmove',x+60,y+1);
 touch('touchstart',x,y); const multiNative = touch('touchmove',x,y+60,true);
 const untouched = data.length === 0;
 allowed=false; touch('touchstart',x,y); const readOnlyNative=touch('touchmove',x,y+60); const readOnlyQuiet=data.length===0;
 allowed=true; touch('touchstart',x,y); const bounded=!touch('touchmove',x,y+2000); const boundedCount=data.splice(0).length;
 await write('\\x1b[?1000l'); touch('touchstart',x,y); const scrollbackNative=touch('touchmove',x,y+60);
 await write('\\x1b[?9h'); touch('touchstart',x,y); const x10Native=touch('touchmove',x,y+60); await write('\\x1b[?9l');
 await write('\\x1b[?1000h'); touch('touchstart',x,y); touch('touchcancel',x,y); const canceled=touch('touchmove',x,y+60);
 abort.abort(); touch('touchstart',x,y); const detached=touch('touchmove',x,y+60);
 return {consumed,older,newer,horizontalNative,multiNative,untouched,readOnlyNative,readOnlyQuiet,bounded,boundedCount,scrollbackNative,x10Native,canceled,detached,focused:document.activeElement===input};
};
// Ordinary history: xterm 6 has no touch scrolling of its own, so the shipped
// option moves its buffer, wired as session.ts wires it, inside a box that
// overflows like the phone's .term-wrap.
const box = document.getElementById('box'), host = document.getElementById('history');
const hist = new Terminal({cols:40,rows:10}); hist.open(host);
const histAbort = new AbortController(); let histMouse = false; const histWheel = [];
mountTerminalTouchScroll(box, { enabled: () => histMouse, lineHeight: () => 20, signal: histAbort.signal, wheel: (x,y,d) => histWheel.push(d),
 scrollback: { room: d => d < 0 ? hist.buffer.active.viewportY > 0 : hist.buffer.active.viewportY < hist.buffer.active.baseY, scroll: n => hist.scrollLines(n) } });
const hTouch = (type,x,y) => { const t = new Touch({identifier:7,target:host,clientX:x,clientY:y}); return host.dispatchEvent(new TouchEvent(type,{touches:type==='touchend'?[]:[t],targetTouches:type==='touchend'?[]:[t],changedTouches:[t],bubbles:true,cancelable:true})); };
const hSwipe = (dy) => { const r = host.querySelector('.xterm-screen').getBoundingClientRect(), x = r.left + 20, y = r.top + 40; hTouch('touchstart',x,y); const native = hTouch('touchmove',x,y+dy); hTouch('touchend',x,y+dy); return native; };
window.histRect = () => { const r = host.querySelector('.xterm-screen').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) }; };
window.histView = () => ({ viewportY: hist.buffer.active.viewportY, baseY: hist.buffer.active.baseY, boxTop: box.scrollTop });
window.histBottom = () => { hist.scrollToBottom(); box.scrollTop = 0; };
// The key bar as session.ts mounts it, beside a composer that keeps the phone's keyboard up.
const keyRoot = document.getElementById('keys'), composer2 = document.getElementById('composer2');
const sentKeys = [], keyEvents = [];
// eofConfirmMs: a driven tap can reach the page 2 s after it was sent on a CI runner, so two of them outlast the shipped
// 3 s (gotcha 180); the shipped value is asserted on its own (eofConfirmDefault).
mountTerminalKeys(keyRoot, { write: value => { sentKeys.push(value); return true; }, applicationCursorMode: () => false, signal: new AbortController().signal, eofConfirmMs: 20000 }).setEnabled(true);
window.eofConfirmDefault = EOF_CONFIRM_MS;
// The window, bubble phase: after every listener on the control itself has run.
for (const type of ['pointerdown', 'mousedown', 'click']) window.addEventListener(type, e => { if (e.target.closest && e.target.closest('#keys button')) keyEvents.push(type + (e.defaultPrevented ? ' cancelled' : '')); });
window.keyAt = sel => { const b = keyRoot.querySelector(sel); if (!b || !b.getClientRects().length) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
window.keyFocus = () => { composer2.focus(); keyEvents.length = 0; sentKeys.length = 0; return document.activeElement === composer2; };
window.keyRead = () => ({ events: keyEvents.splice(0), sent: sentKeys.splice(0), focused: document.activeElement === composer2, panel: !keyRoot.querySelector('.keys-panel').hidden,
 tab: keyRoot.querySelector('[role=tab][aria-selected="true"]').textContent, eof: keyRoot.querySelector('.key-eof').textContent, shift: keyRoot.querySelector('.key-modifier[data-key="Shift"]').dataset.state });
window.exerciseHistory = async () => {
 await new Promise(done => hist.write(Array.from({length:60}, (_, i) => 'history ' + (i + 1)).join('\\r\\n'), done));
 const v = () => hist.buffer.active.viewportY, base = hist.buffer.active.baseY;
 const olderNative = hSwipe(60), olderBy = base - v();
 const newerNative = hSwipe(-60), newerAt = v();
 const atBottomNative = hSwipe(-60);
 hist.scrollToTop(); const atTopNative = hSwipe(60), stillTop = v();
 hist.scrollToBottom(); box.scrollTop = 4; const boxFirstNative = hSwipe(60), boxFirstKept = v() === base; box.scrollTop = 0;
 histMouse = true; const wheelNative = hSwipe(60), wheelSent = histWheel.length, wheelKept = v() === base; histMouse = false;
 return { base, olderNative, olderBy, newerNative, newerAt, atBottomNative, atTopNative, stillTop, boxFirstNative, boxFirstKept, boxOverflows: box.scrollHeight > box.clientHeight, wheelNative, wheelSent, wheelKept };
};`)
    await build({ configFile: false, logLevel: 'error', resolve: { alias: { '@shared': resolve('src/shared') } }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<link rel="stylesheet" href="bundle/fixture.css"><div id="terminal" style="height:220px;width:400px"></div><textarea id="composer"></textarea><div id="box" style="height:150px;width:400px;overflow:auto;overscroll-behavior:contain"><div id="history"></div></div><div style="position:fixed;top:0;right:0;width:360px"><textarea id="composer2" rows="1"></textarea><div id="keys"></div></div><script src="bundle/fixture.js"></script>')
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(join(temp, 'index.html'))
    const result = await win.webContents.executeJavaScript('window.exercise()')
    assert.equal(result.consumed, true)
    assert.equal(result.older.length, 3)
    assert.ok(result.older.every((value: string) => /^\x1b\[<64;\d+;\d+M$/.test(value)), 'downward swipe reports wheel-up through xterm')
    assert.equal(result.newer.length, 3)
    assert.ok(result.newer.every((value: string) => /^\x1b\[<65;\d+;\d+M$/.test(value)), 'upward swipe reports wheel-down through xterm')
    for (const key of ['horizontalNative', 'multiNative', 'untouched', 'readOnlyNative', 'readOnlyQuiet', 'bounded', 'scrollbackNative', 'x10Native', 'canceled', 'detached', 'focused']) assert.equal(result[key], true, key)
    assert.equal(result.boundedCount, 6)
    console.log('PASS real xterm phone swipes: both directions, composer focus, read-only, horizontal pan, multi-touch, bounded reports and cleanup.')
    // Ordinary scrollback, which a finger never moved under xterm 6 (owner, 2026-10-28: "can't scroll").
    const history = await win.webContents.executeJavaScript('window.exerciseHistory()')
    assert.ok(history.base >= 50, `the fixture has scrollback: ${JSON.stringify(history)}`)
    assert.equal(history.olderNative, false, 'a downward swipe over history is taken, not left to a native scroller xterm 6 does not have')
    assert.equal(history.olderBy, 3, 'a 60px downward swipe shows three older 20px lines')
    assert.equal(history.newerNative, false, 'an upward swipe is taken while newer lines are below')
    assert.equal(history.newerAt, history.base, 'and returns to the bottom')
    assert.equal(history.atBottomNative, true, 'at the bottom an upward swipe is the box’s own')
    assert.equal(history.atTopNative, true, 'at the top a downward swipe is the box’s own')
    assert.equal(history.stillTop, 0)
    assert.equal(history.boxOverflows, true, 'the box overflows, as a tall desktop grid does')
    assert.equal(history.boxFirstNative, true, 'a box scrolled down scrolls itself up before any older line')
    assert.equal(history.boxFirstKept, true)
    assert.equal(history.wheelNative, false, 'an application with mouse reporting still gets the swipe')
    assert.ok(history.wheelSent > 0 && history.wheelKept, 'as wheel reports, the buffer untouched')
    // The same through Chromium's own touch pipeline: trusted touches from CDP's Input.dispatchTouchEvent, not
    // events a script dispatched. Never synthesizeScrollGesture's touch source: on Linux it sends no touchmove (gotcha 180).
    await win.webContents.executeJavaScript('window.histBottom()')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    const at = await win.webContents.executeJavaScript('window.histRect()')
    const before = await win.webContents.executeJavaScript('window.histView()')
    await touchDrag((method, params) => win.webContents.debugger.sendCommand(method, params), at.x, at.y, 100)
    const after = await win.webContents.executeJavaScript('window.histView()')
    assert.ok(after.viewportY < before.viewportY, `a real finger-down swipe shows older lines: ${JSON.stringify({ before, after })}`)
    assert.equal(after.boxTop, 0, 'and the box did not scroll instead')
    console.log(`PASS phone scrollback swipes: older/newer lines through the shipped module, the box's own overflow first, mouse-reporting apps untouched, and a trusted Chromium swipe moved ${before.viewportY - after.viewportY} lines.`)
    /*
     * The key bar, tapped with Chromium's trusted touch while a composer has
     * focus. A control that acts on its CLICK keeps that focus by cancelling
     * its mousedown and leaves its pointerdown alone: WebKit drops a tap's
     * click when the pointerdown was cancelled, so in WebKit 26.6 More, the
     * group tabs, Ctrl+D and every key sent on click did nothing (Chromium
     * fires the click either way, so here the rule is read off the events:
     * `pointerdown` uncancelled, `mousedown cancelled`, `click`). A key that
     * acts on the press itself (a repeat key, a modifier) sends once.
     */
    const dbg = win.webContents.debugger
    const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
    const tapKey = async (selector: string, mouse = false): Promise<any> => {
      const at = await win!.webContents.executeJavaScript(`window.keyAt(${JSON.stringify(selector)})`)
      assert.ok(at, `${selector} is on screen`)
      assert.equal(await win!.webContents.executeJavaScript('window.keyFocus()'), true, 'the composer has focus before the tap')
      if (mouse) for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
      else {
        // A tap's two halves sent together, then both replies awaited. On the Linux runner a driven touch reaches this
        // page 1.4-2 s after it is sent; sent one after the other's reply, the halves arrived 2 s apart (gotcha 180).
        await Promise.all([
          dbg.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] }),
          dbg.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        ])
      }
      await pause(250)
      return win!.webContents.executeJavaScript('window.keyRead()')
    }
    const onClick = ['pointerdown', 'mousedown cancelled', 'click']
    const clicked = async (name: string, selector: string, want: Record<string, unknown>, mouse = false): Promise<void> => {
      const r = await tapKey(selector, mouse)
      assert.deepEqual({ events: r.events, focused: r.focused, ...Object.fromEntries(Object.keys(want).map(k => [k, r[k]])) }, { events: onClick, focused: true, ...want },
        `${name}: a tap keeps the composer focused by its mousedown, fires the click and does its job, its pointerdown left alone`)
    }
    await clicked('Esc', '.keys-quick [data-key="Escape"]', { sent: ['\x1b'] })
    await clicked('Tab', '.keys-quick [data-key="Tab"]', { sent: ['\t'] })
    await clicked('Enter', '.keys-quick [data-key="Enter"]', { sent: ['\r'] })
    await clicked('Esc by mouse (a laptop browser)', '.keys-quick [data-key="Escape"]', { sent: ['\x1b'] }, true)
    await clicked('More', '.key-more-toggle', { panel: true, sent: [] })
    await clicked('the Shortcuts tab', '[role=tab][id$="tab-shortcuts"]', { tab: 'Shortcuts', sent: [] })
    await clicked('Ctrl+C', '.keys-shortcuts [aria-label^="Control-C"]', { sent: ['\x03'] })
    await clicked('the F keys tab', '[role=tab][id$="tab-functions"]', { tab: 'F keys' })
    await clicked('F2', '.keys-functions [data-key="F2"]', { sent: ['\x1bOQ'] })
    await clicked('the Edit tab', '[role=tab][id$="tab-edit"]', { tab: 'Edit' })
    await clicked('Ctrl+D, first tap', '.key-eof', { eof: 'Confirm', sent: [] })
    await pause(400)
    await clicked('Ctrl+D, second tap', '.key-eof', { eof: 'Ctrl+D', sent: ['\x04'] })
    await clicked('Delete', '.keys-edit [data-key="Delete"]', { sent: ['\x1b[3~'] })
    const backspace = await tapKey('.keys-edit [data-key="Backspace"]')
    assert.deepEqual([backspace.sent, backspace.focused], [['\x7f'], true], `Backspace, a repeat key, sends once on the press and keeps the focus: ${JSON.stringify(backspace)}`)
    await clicked('the Navigate tab', '[role=tab][id$="tab-navigate"]', { tab: 'Navigate' })
    await clicked('Home', '.keys-navigate [data-key="Home"]', { sent: ['\x1b[H'] })
    const shift = await tapKey('.key-modifier[data-key="Shift"]')
    assert.deepEqual([shift.shift, shift.sent, shift.focused], ['next', [], true], `Shift arms for the next key and keeps the focus: ${JSON.stringify(shift)}`)
    const left = await tapKey('.keys-navigate [data-key="ArrowLeft"]')
    assert.deepEqual([left.sent, left.shift, left.focused], [['\x1b[1;2D'], 'off', true], `then Left sends Shift+Left once and releases Shift: ${JSON.stringify(left)}`)
    await clicked('More again', '.key-more-toggle', { panel: false })
    const up = await tapKey('.keys-quick [data-key="ArrowUp"]')
    assert.deepEqual([up.sent, up.focused], [['\x1b[A'], true], `Up, a repeat key, sends once on the press and keeps the focus: ${JSON.stringify(up)}`)
    assert.equal(await win.webContents.executeJavaScript('window.eofConfirmDefault'), 3000, 'the shipped Ctrl+D confirm window is 3 s (the suite widens it only for its own taps)')
    console.log('PASS phone key bar taps: every control that acts on its click (Esc, Tab, Enter, More, the group tabs, Ctrl+C, F2, Ctrl+D, Delete, Home, and Esc by mouse) keeps the composer focused by its mousedown and fires its click with its pointerdown left alone (WebKit drops the click otherwise); repeat keys and Shift send once on the press.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
