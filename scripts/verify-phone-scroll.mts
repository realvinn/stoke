/** Exercise shipped touch routing with real xterm mouse reporting in Chromium. */
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
    await build({ configFile: false, logLevel: 'error', build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<link rel="stylesheet" href="bundle/fixture.css"><div id="terminal" style="height:220px;width:400px"></div><textarea id="composer"></textarea><div id="box" style="height:150px;width:400px;overflow:auto;overscroll-behavior:contain"><div id="history"></div></div><script src="bundle/fixture.js"></script>')
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
    // The same through Chromium's own touch pipeline: a trusted swipe, not a dispatched event.
    await win.webContents.executeJavaScript('window.histBottom()')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    const at = await win.webContents.executeJavaScript('window.histRect()')
    const before = await win.webContents.executeJavaScript('window.histView()')
    await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', { x: at.x, y: at.y, yDistance: 100, gestureSourceType: 'touch', speed: 800 })
    const after = await win.webContents.executeJavaScript('window.histView()')
    assert.ok(after.viewportY < before.viewportY, `a real finger-down swipe shows older lines: ${JSON.stringify({ before, after })}`)
    assert.equal(after.boxTop, 0, 'and the box did not scroll instead')
    console.log(`PASS phone scrollback swipes: older/newer lines through the shipped module, the box's own overflow first, mouse-reporting apps untouched, and a trusted Chromium swipe moved ${before.viewportY - after.viewportY} lines.`)
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
