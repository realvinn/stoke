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
window.stoke={hub:{remote:{type:async(id,text)=>{if(window.fail)return {ok:false,message:'Disconnected'};window.sent.push({id,text});return {ok:true}}}}};
function Fixture(){const [state,setState]=useState('reconnecting');window.setLink=setState;const receive=useRef(null);window.typeOffline=text=>receive.current?.(text);
return <RemoteDraft scope="fixture-remote" receive={receive} view={{id:'remote-one',state,deviceLabel:'Laptop',mode:'full',typeOnly:true}}/>;}
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
    assert.equal(await run(`document.querySelector('button').disabled`), true, 'offline cannot insert')
    await settle(550)
    await win.reload()
    await new Promise<void>(done => win!.webContents.once('did-finish-load', () => done()))
    await settle()
    assert.equal(await run(`document.querySelector('textarea').value`), 'hello', 'draft survives reload without sending')
    assert.equal(await run('window.sent.length'), 0)
    await run(`window.setLink('open')`); await settle()
    assert.equal(await run('window.sent.length'), 0, 'reconnect alone never replays input')
    await run(`window.fail=true;document.querySelector('button').click()`); await settle()
    assert.equal(await run(`document.querySelector('textarea').value`), 'hello', 'failed insertion preserves text')
    await run(`window.fail=false;document.querySelector('button').click()`); await settle()
    assert.deepEqual(await run('window.sent'), [{ id: 'remote-one', text: 'hello' }], 'explicit insertion uses the text-only API')
    assert.equal(await run(`document.querySelector('textarea').value`), '')
    assert.deepEqual(errors, [])
    await partition.clearStorageData()
    console.log('PASS remote offline draft: literal typing, storage recovery, disconnect guard, no reconnect replay and explicit text-only insertion.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1) })
