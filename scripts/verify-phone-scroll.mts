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
};`)
    await build({ configFile: false, logLevel: 'error', build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<link rel="stylesheet" href="bundle/fixture.css"><div id="terminal" style="height:220px;width:400px"></div><textarea id="composer"></textarea><script src="bundle/fixture.js"></script>')
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
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
