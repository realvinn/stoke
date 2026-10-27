import { app, BrowserWindow, session } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/remote-draft-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.tsx')
    writeFileSync(entry, `import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteDraft} from ${JSON.stringify(resolve('src/renderer/src/components/RemoteDraft.tsx'))};
import ${JSON.stringify(resolve('src/renderer/src/styles/app.css'))};
window.sent=[];window.fail=false;
window.stoke={hub:{remote:{type:async(id,text,enter)=>{if(window.fail)return {ok:false,message:'Disconnected'};window.sent.push({id,text,enter});return {ok:true}}}}};
function Fixture(){const [state,setState]=useState('reconnecting');window.setLink=setState;const receive=useRef(null);window.typeOffline=text=>receive.current?.(text);
return <RemoteDraft scope="fixture-remote" receive={receive} view={{id:'remote-one',state,deviceLabel:'Laptop',mode:'full',typeOnly:true,session:{activity:'idle'}}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`)
    await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': resolve('src/shared') } }, esbuild: { jsx: 'automatic' }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="bundle/fixture.css"><div id="root"></div><script src="bundle/fixture.js"></script>')
    const partition = session.fromPartition(`remote-draft-${Date.now()}`)
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, session: partition } })
    const errors: string[] = []
    win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message) })
    await win.loadFile(join(temp, 'index.html'))
    const run = (code: string) => win!.webContents.executeJavaScript(code)
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
    await run(`window.fail=true;[...document.querySelectorAll('button')].find(b=>b.textContent==='Insert only').click()`); await settle()
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
    assert.deepEqual(errors, [])
    await partition.clearStorageData()
    console.log('PASS complete remote drafts: online/offline typing, storage recovery, preserved caret, explicit submission, recovery copies and no reconnect replay.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1) })
