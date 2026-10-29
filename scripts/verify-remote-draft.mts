import { app, BrowserWindow, session } from 'electron'
import { captureTestWindow } from './capture-test-window.mts'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/remote-input-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.tsx')
    writeFileSync(entry, `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EMBER} from ${JSON.stringify(resolve('src/shared/themes.ts'))};
import {TERMINAL_DEFAULTS} from ${JSON.stringify(resolve('src/shared/ui.ts'))};
import {VOICE_DEFAULTS} from ${JSON.stringify(resolve('src/shared/voiceSettings.ts'))};
import {applyAppearance} from ${JSON.stringify(resolve('src/renderer/src/lib/theme.ts'))};
import '@xterm/xterm/css/xterm.css';
import ${JSON.stringify(resolve('src/renderer/src/styles/app.css'))};
window.inputs=[];window.submits=[];window.deferType=false;window.stoke={platform:'darwin',clipboard:{readSync:()=>({text:'',hasImage:false,files:0}),writeText:()=>{}},audio:{voiceState:async()=>null},hub:{remote:{onFrame:()=>()=>{},rendererAttached:()=>{},resize:()=>{},input:(id,data)=>window.inputs.push({id,data}),type:async(...args)=>{window.submits.push(args);if(window.deferType)return new Promise((resolve,reject)=>{window.releaseType=(ok=true)=>ok?resolve({ok:true}):reject(new Error('Delivery unknown'))});return {ok:true}}}}};
applyAppearance(EMBER,null);
const {RemoteTerminal}=await import(${JSON.stringify(resolve('src/renderer/src/components/RemoteTerminal.tsx'))});
function Fixture(){const [state,setState]=useState('open');const [activity,setActivity]=useState('idle');const [ordered,setOrdered]=useState(true);window.setLink=setState;window.setActivity=setActivity;window.setOrdered=setOrdered;return <div className="fixture"><RemoteTerminal tab={{id:'tab',title:'Codex',remote:{tabId:'remote',device:'work',deviceLabel:'Work desktop',ptyId:'pty'}}} view={{id:'remote',state,deviceLabel:'Work desktop',platform:'darwin',title:'Codex',mode:'full',typeOnly:true,orderedInput:ordered,session:{activity}}} active={true} theme={EMBER} fontFamily="monospace" fontSize={14} terminal={TERMINAL_DEFAULTS} accent={null} alpha={1} bar="fab" voice={VOICE_DEFAULTS} onClose={()=>{}} onOpenUrl={()=>{}} /></div>};
createRoot(document.getElementById('root')).render(<Fixture/>);`)
    await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': resolve('src/shared') } }, esbuild: { jsx: 'automatic', target: 'esnext' }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, target: 'esnext', rollupOptions: { input: entry, output: { format: 'es', entryFileNames: 'fixture.js', assetFileNames: 'assets/[name][extname]' } } } })
    writeFileSync(join(temp, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="bundle/assets/fixture.css"><style>html,body,#root,.fixture{height:100%;margin:0}.fixture{display:flex}.remote-pane{flex:1;min-width:0}</style><div id="root"></div><script type="module" src="bundle/fixture.js"></script>')
    win = new BrowserWindow({ width: 900, height: 640, show: process.platform === 'linux', webPreferences: { backgroundThrottling: false, session: session.fromPartition(`remote-input-${Date.now()}`) } })
    const errors: string[] = []
    win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message) })
    await win.loadFile(join(temp, 'index.html'))
    const run = (code: string) => win!.webContents.executeJavaScript(code)
    await new Promise(done => setTimeout(done, 300))
    assert.equal(await run(`!!window.stokeRemoteTerminals?.get('remote')`), true, 'remote terminal mounts')
    assert.equal(await run(`document.querySelector('.remote-draft, .remote-draft-toggle')`), null, 'no separate prompt box or recovery button')
    await run(`localStorage.setItem('stoke.drafts.v2.fixture','existing saved data')`)
    await run(`new Promise(done => window.stokeRemoteTerminals.get('remote').write('Remote agent ready.\\r\\n\\r\\n› ', done))`)
    await run(`window.stokeRemoteTerminals.get('remote').focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' })
    await new Promise(done => setTimeout(done, 100))
    assert.deepEqual(await run('window.inputs'), [{ id: 'remote', data: '\x1b[A' }], 'Up Arrow reaches the agent unchanged')
    assert.deepEqual(await run('window.submits'), [], 'Up Arrow never submits or inserts a stored draft')
    await run(`window.draftKey='stoke.drafts.v2.'+encodeURIComponent(JSON.stringify(['remote-desktop','work','pty']))+'::old';localStorage.setItem(window.draftKey,JSON.stringify({version:1,text:'Saved old prompt',at:Date.now(),kind:'draft',retired:[]}));window.deferType=true`)
    await run(`window.setActivity('waiting')`); await new Promise(done => setTimeout(done, 100))
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.equal(await run('window.submits.length'), 0, 'Up cannot insert a draft into a permission picker')
    await run(`window.setActivity('idle')`); await new Promise(done => setTimeout(done, 100))
    await run(`window.setOrdered(false)`); await new Promise(done => setTimeout(done, 100))
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.equal(await run('window.submits.length'), 0, 'an older host cannot start an unordered recovery')
    await run(`window.setOrdered(true)`); await new Promise(done => setTimeout(done, 100))
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' })
    await new Promise(done => setTimeout(done, 100))
    assert.deepEqual(await run('window.submits'), [['remote', 'Saved old prompt', false]], 'Up inserts the matching saved draft without Enter')
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true);window.stokeRemoteTerminals.get('remote').input('x',true)`)
    assert.equal(await run('window.submits.length'), 1, 'repeated Up cannot duplicate an in-flight recovery')
    assert.equal(await run('window.inputs.length'), 2, 'subsequent input waits for recovery')
    await run(`window.releaseType()`); await new Promise(done => setTimeout(done, 100))
    assert.deepEqual(await run('window.inputs[2]'), { id: 'remote', data: 'x' }, 'later typing follows the recovered draft')
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.deepEqual(await run('window.inputs[3]'), { id: 'remote', data: '\x1b[A' }, 'later Up uses the agent history')
    assert.equal(await run(`JSON.parse(localStorage.getItem(window.draftKey)).text`), 'Saved old prompt', 'recovery does not erase the saved copy')
    await run(`window.setLink('reconnecting')`); await new Promise(done => setTimeout(done, 100))
    await run(`window.stokeRemoteTerminals.get('remote').input('offline',true)`)
    assert.equal(await run('window.inputs.length'), 4, 'offline input is not replayed')
    await run(`window.setLink('open')`); await new Promise(done => setTimeout(done, 100))
    assert.equal(await run('window.inputs.length'), 4, 'reconnection never replays input')
    assert.equal(await run(`localStorage.getItem('stoke.drafts.v2.fixture')`), 'existing saved data', 'legacy saved data remains untouched')
    assert.deepEqual(errors, [], 'no renderer errors')
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Remote terminal screenshot did not render within 10 seconds.')), 10_000) })
    try { writeFileSync(resolve('out/remote-native-input.png'), (await Promise.race([captureTestWindow(win), deadline])).toPNG()) }
    finally { clearTimeout(timer) }
    await win.reload(); await new Promise(done => setTimeout(done, 300))
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.deepEqual(await run('window.submits'), [], 'a recovered draft is not inserted again after reopening')
    assert.deepEqual(await run('window.inputs'), [{ id: 'remote', data: '\x1b[A' }], 'Up after reopening reaches native history')
    await run(`localStorage.removeItem('stoke.remote-restored.v1.'+encodeURIComponent(JSON.stringify(['remote-desktop','work','pty'])))`)
    await win.reload(); await new Promise(done => setTimeout(done, 300))
    await run(`window.deferType=true;window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    await run(`window.stokeRemoteTerminals.get('remote').input('\\r',true);window.releaseType(false)`)
    await new Promise(done => setTimeout(done, 100))
    assert.deepEqual(await run('window.inputs'), [], 'a queued Enter is not sent after an uncertain recovery')
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.equal(await run('window.submits.length'), 1, 'an uncertain delivery is not repeated on another Up')
    assert.deepEqual(await run('window.inputs'), [{ id: 'remote', data: '\x1b[A' }], 'after an uncertain delivery Up goes to the agent')
    await win.reload(); await new Promise(done => setTimeout(done, 300))
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.deepEqual(await run('window.submits'), [], 'an uncertain delivery is not repeated after reopening')
    await run(`localStorage.removeItem('stoke.remote-restored.v1.'+encodeURIComponent(JSON.stringify(['remote-desktop','work','pty'])))`)
    await win.reload(); await new Promise(done => setTimeout(done, 300))
    await run(`window.stokeRemoteTerminals.get('remote').input('existing text',true);window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.deepEqual(await run('window.submits'), [], 'a saved draft is never inserted over text already typed in this view')
    assert.deepEqual(await run('window.inputs.map(x=>x.data)'), ['existing text', '\x1b[A'], 'typing followed by Up reaches the agent normally')
    await run(`localStorage.setItem('stoke.drafts.v2.'+encodeURIComponent(JSON.stringify(['remote-desktop','work','pty']))+'::multiline',JSON.stringify({version:1,text:'line one\\nline two',at:Date.now()+1,kind:'draft',retired:[]}))`)
    await win.reload(); await new Promise(done => setTimeout(done, 300))
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.deepEqual(await run('window.submits'), [], 'multiline recovery cannot send raw Enter into an unprotected terminal')
    await run(`new Promise(done=>window.stokeRemoteTerminals.get('remote').write('\\x1b[?2004h',done))`)
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`); await new Promise(done => setTimeout(done, 100))
    assert.deepEqual(await run('window.submits'), [['remote', 'line one\nline two', false]], 'multiline recovery inserts without Enter when bracketed paste is enabled')
    await run(`localStorage.setItem('stoke.drafts.v2.'+encodeURIComponent(JSON.stringify(['remote-desktop','work','pty']))+'::control',JSON.stringify({version:1,text:'text\\x1b[A',at:Date.now()+5,kind:'draft',retired:[]}))`)
    await win.reload(); await new Promise(done => setTimeout(done, 300))
    await run(`window.stokeRemoteTerminals.get('remote').input('\\x1b[A',true)`)
    assert.deepEqual(await run('window.submits'), [], 'control characters in saved text are not sent to the agent')
    assert.deepEqual(errors, [], 'no renderer errors after reconnect or reload')
    console.log('PASS Up restores the matching saved draft once without Enter, then uses native history; no prompt box or offline replay.')
  } finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }) }
}
app.whenReady().then(main).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
