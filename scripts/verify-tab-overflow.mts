import { captureTestWindow } from './capture-test-window.mts'
/** Real TitleBar + CSS in Chromium: mouse-only access to overflowed tabs. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/tab-overflow-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.tsx')
    writeFileSync(entry, `import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
import { applyTheme } from ${JSON.stringify(resolve('src/renderer/src/lib/theme.ts'))};
import { EMBER } from ${JSON.stringify(resolve('src/shared/themes.ts'))};
applyTheme(EMBER);
  import { TitleBar } from ${JSON.stringify(resolve('src/renderer/src/components/TitleBar.tsx'))};
  import ${JSON.stringify(resolve('src/renderer/src/styles/app.css'))};
  const noop = () => {};
  window.stoke = { platform: 'win32', usage: { read: async () => ({ readings: [{key:'anthropic:default',source:'anthropic',cli:'claude',accountId:'default',label:'Default',detail:null,snapshot:{windows:[{kind:'session',label:'5 hours',percent:40,severity:'normal',resetsAt:Date.now()+3600000},{kind:'weekly',label:'Weekly',percent:20,severity:'normal',resetsAt:Date.now()+86400000}],extraCredits:null,fetchedAt:Date.now(),error:null}}], activeKey: 'anthropic:default', target: null }) }, statusLine: { last: async () => [], onUpdate: () => noop }, remote: { status: async () => null, onChange: () => noop } };
  function Fixture() {
   const [count, setCount] = useState(20); const [active, setActive] = useState('0');
   window.setCount = setCount; window.setActive = setActive;
   const tabs = Array.from({length: count}, (_, i) => ({id: String(i), kind: i === 1 ? 'remote' : 'new', title: 'Project ' + i, cwd: '/project', sessionId: '', ptyId: String(i), status: 'paused'}));
   return <TitleBar platform="win32" showBrand maximized={false} fullScreen={false} tabs={tabs} activeTabId={active} contexts={{}} activity={{'1':{dot:'working',label:'Agent is working…',detail:null,notify:false}}} watchedSessions={new Set()} sidebarOpen={false} browserOpen={false} worklogCount={0} worklogState="disarmed" worklogOpen={false} settingsOpen={false} onSelectTab={setActive} {...Object.fromEntries(['onCloseTab','onRenameTab','onCloseTabsSide','onNewTab','onDetachTab','onReorderTab','onToggleSidebar','onToggleBrowser','onToggleWorklog','onOpenPalette','onOpenSettings','onOpenPhoneSettings'].map(key => [key, noop]))} />;
  }
  window.stoke.usage.all = window.stoke.usage.read;
  createRoot(document.getElementById('root')).render(<Fixture/>);`)
    await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': resolve('src/shared') } }, esbuild: { jsx: 'automatic' }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<link rel="stylesheet" href="bundle/fixture.css"><style>.titlebar{height:var(--titlebar-h)}.titlebar[data-platform="win32"]{padding-right:148px}</style><div id="root"></div><script src="bundle/fixture.js"></script>')
    await app.whenReady()
    win = new BrowserWindow({ width: 940, height: 300, show: process.platform === 'linux', webPreferences: { backgroundThrottling: false } })
    const errors: string[] = []
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    await win.loadFile(join(temp, 'index.html'))
    const run = (code: string) => win!.webContents.executeJavaScript(code)
    const settle = () => new Promise((done) => setTimeout(done, 100))
    await settle()
    assert.deepEqual(errors, [], 'fixture mounts the real title bar without renderer errors')
    assert.equal(await run(`document.querySelector('[data-tab-id="1"] .tab-activity')?.dataset.state`), 'working', 'remote tabs draw activity dots too')
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-activity')).animationName`), 'activity-pulse')
    await run(`document.querySelector('[data-tab-id="1"] .tab-activity').dataset.state='waiting'`)
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-activity')).animationName`), 'none', 'blocking questions use a solid dot')
    for (const scale of [16, 25.6]) {
      await run(`document.documentElement.style.fontSize = '${scale}px'; window.setActive('0')`)
      await settle()
      assert.equal(await run(`!!document.querySelector('[aria-label="Scroll session tabs"]')`), true)
      assert.equal(await run(`document.querySelector('[aria-label="Scroll tabs left"]').disabled`), true)
      assert.equal(await run(`(() => { const tabs = document.querySelector('.tabs').getBoundingClientRect(), actions = document.querySelector('.titlebar-actions').getBoundingClientRect(); return tabs.right <= actions.left && actions.right <= innerWidth - 140; })()`), true, 'usage and native controls have reserved space')
      assert.equal(await run(`getComputedStyle(document.querySelector('.usage-mini-track')).display`), 'none', 'compact usage hides the mini bar while preserving labels and percentages')
      assert.ok(await run(`document.querySelector('.usage-mini-left').textContent.includes('60')`))
      const before = await run(`document.querySelector('.tablist').scrollLeft`)
      await run(`document.querySelector('[aria-label="Scroll tabs right"]').click()`)
      await settle()
      assert.ok(await run(`document.querySelector('.tablist').scrollLeft`) > before, 'right button advances the strip')
      const afterRight = await run(`({left: document.querySelector('.tablist').scrollLeft, disabled: document.querySelector('[aria-label="Scroll tabs left"]').disabled, width: document.querySelector('.tablist').clientWidth})`)
      await run(`document.querySelector('[aria-label="Scroll tabs left"]').click()`)
      await settle()
      const afterLeft = await run(`document.querySelector('.tablist').scrollLeft`)
      assert.ok(afterLeft < afterRight.left, JSON.stringify({ scale, before, afterRight, afterLeft }))
      await run(`document.querySelector('.tablist').scrollLeft = 0`)
      await settle()
      assert.equal(await run(`document.querySelector('.tablist').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true }))`), false, 'ordinary mouse wheel is handled')
      await settle()
      assert.ok(await run(`document.querySelector('.tablist').scrollLeft`) > 0)
      const horizontal = await run(`document.querySelector('.tablist').scrollLeft`)
      await run(`document.querySelector('.tablist').dispatchEvent(new WheelEvent('wheel', { deltaX: 80, cancelable: true }))`)
      await settle()
      assert.ok(await run(`document.querySelector('.tablist').scrollLeft`) > horizontal, 'horizontal trackpad scrolling remains available')
      assert.equal(await run(`document.querySelector('.tablist').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true }))`), true, 'Ctrl+wheel remains available for zoom')
      await run(`window.setActive('19')`)
      await settle()
      const geometry = await run(`(() => { const list=document.querySelector('.tablist').getBoundingClientRect(), tab=document.querySelector('[aria-selected="true"]').getBoundingClientRect(); return {list: {left:list.left,right:list.right}, tab: {left:tab.left,right:tab.right}, selected: document.querySelector('[aria-selected="true"]').dataset.tabId}; })()`)
      assert.ok(geometry.tab.right <= geometry.list.right + 1 && geometry.tab.left >= geometry.list.left - 1, 'selected last tab is fully visible: ' + JSON.stringify({ scale, ...geometry }))
      assert.equal(await run(`document.querySelector('[aria-label="Scroll tabs right"]').disabled`), true)
      await run(`window.setActive('0')`)
      await settle()
    }
    await run(`document.querySelector('.usage-chip').click()`)
    await settle()
    assert.equal(await run(`(() => {const r=document.querySelector('.popover-backdrop').getBoundingClientRect(); return r.width >= innerWidth && r.height >= innerHeight;})()`), true, 'responsive title bar does not confine the usage click-away backdrop')
    await run(`document.querySelector('.popover-backdrop').click()`)
    await settle()
    writeFileSync(resolve('out/tab-overflow.png'), (await captureTestWindow(win)).toPNG())
    await run(`document.documentElement.style.fontSize = '16px'; window.setCount(1)`)
    await settle()
    assert.equal(await run(`!!document.querySelector('[aria-label="Scroll session tabs"]')`), false, 'controls disappear when tabs fit')
    console.log('PASS real title bar: overflow buttons, mouse wheel, zoom, selection, usage clearance and interface scaling.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
