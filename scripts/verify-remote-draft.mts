import { captureTestWindow } from './capture-test-window.mts'
import { app, BrowserWindow, session } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

// This suite screenshots a hidden window, so it must keep drawing while hidden
// or covered (CLAUDE.md's standing traps; drive-account-remote runs the same way).
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/remote-draft-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.tsx')
    writeFileSync(entry, `import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {installShiftSelection,installTerminalClipboard} from ${JSON.stringify(resolve('src/renderer/src/lib/terminalSelection.ts'))};
import {OtherMachines} from ${JSON.stringify(resolve('src/renderer/src/components/OtherMachines.tsx'))};
import {applyAppearance} from ${JSON.stringify(resolve('src/renderer/src/lib/theme.ts'))};
import {EMBER} from ${JSON.stringify(resolve('src/shared/themes.ts'))};
applyAppearance(EMBER,null);
import {RemoteDraft} from ${JSON.stringify(resolve('src/renderer/src/components/RemoteDraft.tsx'))};
import ${JSON.stringify(resolve('src/renderer/src/styles/app.css'))};
window.sent=[];window.fail=false;
window.makeClipboard=async isMac=>{const host=document.createElement('div');document.querySelector('.fixture-screen').append(host);const term=new Terminal({cols:40,rows:5,fontSize:13});term.open(host);window.clipTerm=term;window.clipWrites=[];window.clipInputs=[];window.clipMenus=[];
const selection=installShiftSelection(host,term,isMac);const remove=installTerminalClipboard(host,term,{isMac,read:()=>'clipboard text',write:text=>window.clipWrites.push(text),menu:(event,text)=>window.clipMenus.push(text)});term.onData(data=>window.clipInputs.push(data));
window.clipHost=host;window.disposeClipboard=()=>{remove();selection();term.dispose();host.remove()};await new Promise(done=>term.write('copy me'+String.fromCharCode(13,10,27)+'[?1000h',done));};
window.stoke={hub:{remote:{type:async(id,text,enter)=>{if(window.fail)return {ok:false,message:'Disconnected'};window.sent.push({id,text,enter});return {ok:true}}}}};
function Fixture(){const [state,setState]=useState('reconnecting');window.setLink=setState;const [scope,setScope]=useState('fixture-remote');window.setScope=setScope;const [machines,setMachines]=useState(null);window.setMachines=setMachines;const receive=useRef(null);window.typeOffline=text=>receive.current?.(text);
return <div className="fixture"><div className="fixture-screen">Stoke · Work desktop<br/><br/>Agent output remains visible while you write.{machines&&<OtherMachines view={machines} onOpen={()=>{}}/>}</div><RemoteDraft label="Work desktop · Stoke chat" scope={scope} receive={receive} view={{id:'remote-one',state,deviceLabel:'Laptop',mode:'full',typeOnly:true,session:{activity:'idle'}}}/></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`)
    await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': resolve('src/shared') } }, esbuild: { jsx: 'automatic' }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="bundle/fixture.css"><style>.fixture{height:100vh;display:flex;flex-direction:column}.fixture-screen{flex:1;min-height:0;padding:20px;color:var(--text-muted);font-family:var(--mono)}</style><div id="root"></div><script src="bundle/fixture.js"></script>')
    const partition = session.fromPartition(`remote-draft-${Date.now()}`)
    win = new BrowserWindow({ width: 900, height: 640, show: process.platform === 'linux', webPreferences: { backgroundThrottling: false, session: partition } })
    const errors: string[] = []
    win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message) })
    await win.loadFile(join(temp, 'index.html'))
    const run = async (code: string) => { try { return await win!.webContents.executeJavaScript(code) } catch (cause) { throw new Error(code, {cause}) } }
    const settle = (ms = 80) => new Promise(done => setTimeout(done, ms))
    await settle()
    await run(`window.typeOffline('hello');window.typeOffline('\\x1b[A');window.typeOffline('\\r')`)
    await settle()
    assert.equal(await run(`document.querySelector('textarea').value`), 'hello', 'raw arrows and Enter never enter the draft queue')
    assert.equal(await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Send prompt').disabled`), true, 'offline cannot insert')
    await settle(550)
    await win.reload()
    await new Promise<void>(done => win!.webContents.once('did-finish-load', () => done()))
    await settle()
    assert.equal(await run(`document.querySelector('textarea').value`), 'hello', 'draft survives reload without sending')
    assert.equal(await run('window.sent.length'), 0)
    await run(`window.setLink('open')`); await settle()
    assert.equal(await run('window.sent.length'), 0, 'reconnect alone never replays input')
    await run(`document.querySelector('details').open=true;window.fail=true;[...document.querySelectorAll('button')].find(b=>b.textContent==='Insert only').click()`); await settle()
    assert.equal(await run(`document.querySelector('textarea').value`), 'hello', 'failed insertion preserves text')
    await run(`window.fail=false;[...document.querySelectorAll('button')].find(b=>b.textContent==='Insert only').click()`); await settle()
    assert.deepEqual(await run('window.sent'), [{ id: 'remote-one', text: 'hello', enter: false }], 'explicit insertion uses the text-only API')
    assert.equal(await run(`document.querySelector('textarea').value`), '')
    await run(`window.typeOffline('full prompt before the drop');document.querySelector('textarea').focus();document.querySelector('textarea').setSelectionRange(5,5)`); await settle();
    for (let i=0;i<4;i++) {
      await run(`window.setLink('reconnecting')`); await settle();
      await run(`window.setLink('open')`); await settle();
    }
    assert.equal(await run(`document.querySelector('textarea').value`), 'full prompt before the drop', 'the whole online draft survives repeated drops');
    assert.equal(await run(`document.activeElement===document.querySelector('textarea') && document.querySelector('textarea').selectionStart===5`), true, 'reconnect preserves editor focus and caret');
    assert.equal(await run(`window.sent.length`), 1, 'flapping never replays the prompt');
    await run(`window.typeOffline('X')`);await settle()
    assert.equal(await run(`document.querySelector('textarea').value`), 'full Xprompt before the drop', 'typing after reconnect continues at the saved caret');

    await run(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`); await settle();
    assert.deepEqual(await run('window.sent[1]'), {id:'remote-one',text:'full Xprompt before the drop',enter:true}, 'Send hands the entire draft to the host in one submission');
    assert.ok(await run(`document.querySelector('select').textContent.includes('full Xprompt before the drop')`), 'a submitted prompt retains a local recovery copy');
    // The geometry checks must not read the machine's motion setting. Under
    // prefers-reduced-motion, app.css's global `transition-duration: 1ms` turns
    // the initial `transition-property: all` into a transition on every
    // property, so expanding starts one on the dock's padding-top. A transition
    // starts on the next frame, so in a window that draws none it holds its
    // start, 4px, while the textarea's `position: absolute` (not animatable)
    // lands at once: 1 + 4 + 28 + 4 = 37, the windows-latest leg's 68 -> 37
    // exactly (ffa9975, job 122052788712). Measured there: only that the
    // runner's hidden window drew frames BEFORE a reload (verify:remote-composer
    // and verify:shell-layout screenshot through requestAnimationFrame and pass
    // on that leg). Inferred: that it reports reduce (the same leg failed
    // verify:tab-overflow's pulse check, which only reduce turns off) and that
    // this window draws no frames after its reload. The line below prints both.
    // The frame probe is bounded, so a window that stopped drawing prints 0
    // rather than hanging (`visibilityState` cannot tell: backgroundThrottling
    // false keeps it 'visible'), and it cancels its last request, so no
    // callback is left pending in a window that never paints. With the pin no
    // transition runs on the dock, so the geometry holds whether frames run,
    // crawl or stop. Only the screenshots below need frames, and they fail by
    // name after 10 s rather than hanging the leg: ci-verify.mjs has no
    // per-suite timeout. Rehearsed on a Mac (gotcha 113) under
    // `--force-prefers-reduced-motion`, with animations frozen (CDP
    // `Animation.setPlaybackRate` 0) and, separately, in a hidden window that
    // stops painting (`paintWhenInitiallyHidden: false`,
    // `backgroundThrottling: true`; the probe printed 1 frame): without this
    // pin both fail with exactly 68 -> 37 (padding-top 4px, 10 animations);
    // with it both pass the geometry. The stopped window then fails by name at
    // the first screenshot (16 s for the whole run), as does a page whose
    // requestAnimationFrame never fires (probe 0); without the deadline the
    // capture was still waiting when stopped at 45 s.
    const motion = win.webContents.debugger
    motion.attach('1.3')
    const reducedHere = await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
    const framesAfterReload: number = await run(`new Promise(done=>{let n=0,id=0;const tick=()=>{n++;id=requestAnimationFrame(tick)};id=requestAnimationFrame(tick);setTimeout(()=>{cancelAnimationFrame(id);done(n)},1000)})`)
    console.log(`this machine reports prefers-reduced-motion: ${reducedHere ? 'reduce' : 'no-preference'}; the window drew ${framesAfterReload} animation frames in the 1 s after its reload (the geometry checks pin no-preference)`)
    await motion.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false, 'the no-preference emulation took')
    const geometry=()=>run(`({dock:document.querySelector('.remote-draft').getBoundingClientRect().height,screen:document.querySelector('.fixture-screen').getBoundingClientRect().height})`)
    await run(`document.querySelector('details').open=false;window.typeOffline('Draft saved before the computer stopped.'+String.fromCharCode(10)+'The previous lines are still here.');document.querySelector('textarea').setSelectionRange(12,12);window.fieldNode=document.querySelector('textarea')`);await settle()
    for(const width of [900,390]) {
      win.setSize(width,640);await settle()
      const before=await geometry()
      assert.ok(before.dock<=80,'compact dock stays small: '+JSON.stringify(before))
      await run(`document.querySelector('[aria-controls]').click()`);await settle()
      if (width === 900) console.log(`expanded under the pin: dock padding-top ${await run(`getComputedStyle(document.querySelector('.remote-draft')).paddingTop`)}, ${await run('document.getAnimations().length')} animations on the page`)
      assert.deepEqual(await geometry(),before,'expanding overlays the screen without resizing the terminal')
      assert.equal(await run(`window.fieldNode===document.querySelector('textarea') && document.querySelector('textarea').selectionStart===12`),true,'expand preserves the editor and caret')
      await run(`document.querySelector('[aria-controls]').click();window.setLink('reconnecting')`);await settle()
      assert.deepEqual(await geometry(),before,'connection loss does not introduce a large box or move the terminal')
      await run(`window.setLink('open')`);await settle()
      assert.deepEqual(await geometry(),before,'reconnection does not resize the editor or terminal')
      await run(`document.querySelector('details').open=true`);await settle()
      assert.equal(await run(`(()=>{const r=document.querySelector('.remote-draft-menu').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth})()`),true,'recovery controls fit a narrow window')
      await run(`document.querySelector('details').open=false`)
    }
    win.setSize(900,640);await settle()
    // captureTestWindow waits on requestAnimationFrame with no deadline of its own.
    const capture = async (file: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(Object.assign(new Error(`${file}: no frame within 10 s, so the hidden window has stopped drawing (it drew ${framesAfterReload} frames in the 1 s after its reload)`), { name: 'ScreenshotStalled' })), 10_000) })
      try { writeFileSync(resolve('out', file), (await Promise.race([captureTestWindow(win!), stalled])).toPNG()) } finally { clearTimeout(timer) }
    }
    await capture('remote-draft-compact.png')
    await run(`document.querySelector('[aria-controls]').click()`);await settle()
    await capture('remote-draft-expanded.png')
    await motion.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), reducedHere, 'the emulation is cleared back to this machine’s own setting')
    motion.detach()
    const savedText=await run(`document.querySelector('textarea').value`)
    assert.ok(savedText.includes(String.fromCharCode(10)), 'recovery covers complete multiline prompts')
    await run(`addEventListener('pagehide',()=>localStorage.setItem('fixture-pagehide','yes'))`)
    const gone=new Promise<void>(done=>win!.webContents.once('render-process-gone',()=>done()))
    win.webContents.forcefullyCrashRenderer();await gone
    await win.loadFile(join(temp,'index.html'));await settle()
    assert.equal(await run(`localStorage.getItem('fixture-pagehide')`),null,'abrupt renderer loss ran no shutdown save hook')
    assert.equal(await run(`document.querySelector('textarea').value`),savedText,'the saved prompt is recovered even without shutdown hooks')
    assert.equal(await run(`window.sent.length`),0,'restart never submits recovered text')
    await run(`window.setScope('replacement-session-after-host-restart')`);await settle()
    assert.equal(await run(`document.querySelector('textarea').value`),'','a new host session never inherits another session’s draft silently')
    await run(`document.querySelector('details').open=true`);await settle()
    assert.ok(await run(`document.querySelector('select').textContent.includes('Work desktop · Stoke chat')`),'recovery names the original computer and chat')
    await run(`const select=document.querySelector('select');select.value=[...select.options].find(o=>o.textContent.includes('Draft saved before')).value;select.dispatchEvent(new Event('change',{bubbles:true}))`);await settle()
    assert.equal(await run(`document.querySelector('textarea').value`),savedText,'a restarted host’s replacement session can explicitly recover the complete prompt')
    assert.equal(await run(`window.sent.length`),0,'cross-session recovery only fills the editor')
    await run(`window.setMachines({available:true,machines:[{id:'work',label:'WorkPC',platform:'win32',status:{open:true,sessions:[{ptyId:'one',title:'Working chat',project:'stoke',status:'idle'},{ptyId:'two',title:'Other chat',project:'stoke',status:'idle'},{ptyId:'three',title:'Not opened',project:'stoke',status:'idle'}]}}],tabs:[{device:'work',ptyId:'one',state:'open'},{device:'work',ptyId:'two',state:'reconnecting',message:'Waiting for terminal screen'}]})`);await settle()
    assert.equal(await run(`document.querySelector('[data-pty="one"] .remote-session-link').textContent`),'Connected')
    assert.equal(await run(`document.querySelector('[data-pty="two"] .remote-session-link').textContent`),'Reconnecting','chat link status is independent of machine presence')
    await run(`window.setMachines(previous=>({...previous,machines:previous.machines.map(m=>({...m,reachable:false}))}))`);await settle()
    assert.equal(await run(`document.querySelector('.machine-name').textContent`),'WorkPC','account reconnect keeps the machine visible')
    assert.equal(await run(`document.querySelector('[data-pty="one"]').disabled`),false,'an already connected chat remains selectable')
    assert.equal(await run(`document.querySelector('[data-pty="three"]').disabled`),true,'cached presence does not enable opening an unverified route')
    await run(`window.setMachines(null)`);await settle()
    for(const isMac of [true,false]) {
      await run(`window.makeClipboard(${isMac})`)
      await run(`window.clipTerm.select(0,0,7);window.clipTerm.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'c',code:'KeyC',keyCode:67,bubbles:true,cancelable:true,metaKey:${isMac},ctrlKey:${!isMac},shiftKey:${!isMac}}))`)
      assert.deepEqual(await run('window.clipWrites'),['copy me'],'remote selection copies on '+(isMac?'macOS':'Windows/Linux'))
      assert.deepEqual(await run('window.clipInputs'),[],'copy never becomes an agent interrupt')
      await run(`window.clipTerm.clearSelection();window.clipTerm.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'c',code:'KeyC',keyCode:67,bubbles:true,cancelable:true,ctrlKey:true}))`)
      assert.deepEqual(await run('window.clipInputs'),[String.fromCharCode(3)],'Ctrl+C without a selection still interrupts')
      await run(`window.clipTerm.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'v',code:'KeyV',keyCode:86,bubbles:true,cancelable:true,metaKey:${isMac},ctrlKey:${!isMac},shiftKey:${!isMac}}))`)
      assert.equal(await run(`window.clipInputs.filter(text=>text.includes('clipboard text')).length`),1,'paste happens once')
      const before=await run('window.clipInputs.length')
      await run(`(()=>{window.clipTerm.select(0,0,7);const node=window.clipTerm.element;node.dispatchEvent(new MouseEvent('mousedown',{button:2,buttons:2,bubbles:true,cancelable:true}));node.dispatchEvent(new MouseEvent('mouseup',{button:2,bubbles:true,cancelable:true}));node.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));})()`)
      assert.deepEqual(await run('window.clipMenus'),['copy me'],'right-click retains the highlight for the copy menu')
      assert.equal(await run('window.clipInputs.length'),before,'right-click never pastes or sends remote mouse keys')
      await run(`window.clipTerm.clearSelection();window.clipTerm.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'c',code:'KeyC',keyCode:67,bubbles:true,cancelable:true,metaKey:${isMac},ctrlKey:${!isMac},shiftKey:${!isMac}}))`)
      assert.deepEqual(await run('window.clipWrites'),['copy me'],'copying an empty selection never erases the clipboard')
      await run('window.disposeClipboard()')
    }
    assert.deepEqual(errors, [])
    await partition.clearStorageData()
    console.log('PASS compact remote editor: stable geometry, caret, crash/cross-session recovery, independent chat status, clipboard shortcuts and context menu.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1) })
