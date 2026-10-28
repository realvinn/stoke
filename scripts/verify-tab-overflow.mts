import { captureTestWindow } from './capture-test-window.mts'
/** Real TitleBar + CSS in Chromium: mouse-only access to overflowed tabs. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { contrastRatio } from '../src/shared/color.ts'
import { build } from 'vite'

// On Windows the window is shown (see below), and a shown window that other
// windows cover is backgrounded and stops drawing too. Before ready, at module scope.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/tab-overflow-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.tsx')
    writeFileSync(entry, `import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
import { applyAppearance } from ${JSON.stringify(resolve('src/renderer/src/lib/theme.ts'))};
import { EMBER, BUILT_IN_THEMES } from ${JSON.stringify(resolve('src/shared/themes.ts'))};
window.setTheme = id => applyAppearance(BUILT_IN_THEMES.find(t => t.id === id), null, {colors:{},paint:true});
window.setTheme('ember');
window.themes = BUILT_IN_THEMES.map(t => t.id);
  import { TitleBar } from ${JSON.stringify(resolve('src/renderer/src/components/TitleBar.tsx'))};
  import ${JSON.stringify(resolve('src/renderer/src/styles/app.css'))};
  const noop = () => {};
  window.stoke = { platform: 'win32', usage: { read: async (_reason, target) => ({ readings: [{key:'anthropic:default',source:'anthropic',cli:'claude',accountId:'default',label:'Default',detail:null,snapshot:{windows:[{kind:'session',label:'5 hours',percent:40,severity:'normal',resetsAt:Date.now()+3600000},{kind:'weekly',label:'Weekly',percent:20,severity:'normal',resetsAt:Date.now()+86400000}],extraCredits:null,fetchedAt:Date.now(),error:null}}], activeKey: 'anthropic:default', target: target ?? null }) }, statusLine: { last: async () => [], onUpdate: () => noop }, remote: { status: async () => null, onChange: () => noop } };
  function Fixture() {
   const [count, setCount] = useState(20); const [active, setActive] = useState('0');
   const [sessionTabs,setSessionTabs]=useState(true);window.setSessionTabs=setSessionTabs;
   const [ringStyle,setRingStyle]=useState('solid'); const [remoteState,setRemoteState]=useState('open'); const [remoteUsed,setRemoteUsed]=useState(50000);
   window.setRingStyle=setRingStyle; window.setRemoteState=setRemoteState; window.setRemoteUsed=setRemoteUsed;
   window.setCount = setCount; window.setActive = setActive;
   const tabs = Array.from({length: count}, (_, i) => ({id: String(i), kind: i === 1 ? 'remote' : sessionTabs && i < 3 ? 'session' : 'new', cliId: i === 0 ? 'claude' : 'codex', permissionMode: i === 0 ? 'bypassPermissions' : 'default', remote: i === 1 ? {tabId:'remote-one'} : undefined, title: 'Project ' + i, cwd: '/project', sessionId: String(i), ptyId: String(i), status: i < 3 ? 'running' : 'paused'}));
   return <div className="app" data-context-ring-style={ringStyle}><TitleBar remoteViews={[{id:'remote-one',state:remoteState,session:{agent:'codex',context:{used:remoteUsed,limit:200000}}}]} labelFor={t=>({text:t.title,agent:t.cliId,agentTag:'AGENT TAG',account:null})} platform="win32" showBrand maximized={false} fullScreen={false} tabs={tabs} activeTabId={active} contexts={{'0':{ready:true,contextTokens:50000,contextLimit:200000},'2':{ready:true,contextTokens:50000,contextLimit:200000}}} activity={{'1':{dot:'working',label:'Agent is working…',detail:null,notify:false}}} watchedSessions={new Set()} sidebarOpen={false} browserOpen={false} worklogCount={0} worklogState="disarmed" worklogOpen={false} settingsOpen={false} onSelectTab={setActive} {...Object.fromEntries(['onCloseTab','onRenameTab','onCloseTabsSide','onNewTab','onDetachTab','onReorderTab','onToggleSidebar','onToggleBrowser','onToggleWorklog','onOpenPalette','onOpenSettings','onOpenPhoneSettings'].map(key => [key, noop]))} /></div>;
  }
  window.stoke.usage.all = window.stoke.usage.read;
  createRoot(document.getElementById('root')).render(<Fixture/>);`)
    await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': resolve('src/shared') } }, esbuild: { jsx: 'automatic' }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<link rel="stylesheet" href="bundle/fixture.css"><style>.titlebar{height:var(--titlebar-h)}.titlebar[data-platform="win32"]{padding-right:148px}</style><div id="root"></div><script src="bundle/fixture.js"></script>')
    await app.whenReady()
    // The overflow buttons need drawn frames. useTabOverflow re-reads its edges
    // from the strip's `scroll` event and a requestAnimationFrame, and Chromium
    // runs both only in its rendering steps. A hidden window on windows-latest
    // crawls (verify:remote-draft printed 1 frame in 1 s there), and this suite
    // read the button 100 ms after the right one scrolled: the strip at 285, the
    // left button still disabled (runs 40520686629, 40582687313). Rehearsed on
    // a Mac in a hidden window that stops painting (`paintWhenInitiallyHidden:
    // false`, `backgroundThrottling: true`): 0 to 4 frames a second, the same
    // failure at 291. So each wait on scroll-driven state is a bounded poll that
    // names what never happened (in that rehearsal every one then passed, in
    // under a second each), and on Windows the window is shown without focus,
    // where it draws at full rate (Linux, under Xvfb, always was). macOS stays
    // hidden: its hidden window drew 144 frames a second here, and a shown one
    // would come up over the owner's work on every `npm run check`. The frame
    // probe below prints what each run got.
    win = new BrowserWindow({ width: 940, height: 300, show: process.platform === 'linux', webPreferences: { backgroundThrottling: false } })
    if (process.platform === 'win32') win.showInactive()
    const errors: string[] = []
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    await win.loadFile(join(temp, 'index.html'))
    const run = async (code: string) => { try { return await win!.webContents.executeJavaScript(code) } catch (error) { throw new Error(code, { cause: error }) } }
    const settle = () => new Promise((done) => setTimeout(done, 100))
    await settle()
    // Bounded, and it cancels its last request, so a window that stopped drawing prints 0 rather than hanging.
    const framesAfterLoad: number = await run(`new Promise(done=>{let n=0,id=0;const tick=()=>{n++;id=requestAnimationFrame(tick)};id=requestAnimationFrame(tick);setTimeout(()=>{cancelAnimationFrame(id);done(n)},1000)})`)
    console.log(`the window drew ${framesAfterLoad} animation frames in the 1 s after it loaded (the scroll buttons' state needs frames)`)
    const until = async (code: string, what: string, detail: () => Promise<unknown> = async () => '') => {
      const deadline = Date.now() + 5_000
      while (!(await run(code))) {
        if (Date.now() > deadline) assert.fail(`${what} within 5 s: ${JSON.stringify(await detail())}. useTabOverflow hears a scroll only in a drawn frame, and this window drew ${framesAfterLoad} animation frames in the 1 s after it loaded`)
        await new Promise((done) => setTimeout(done, 50))
      }
    }
    assert.deepEqual(errors, [], 'fixture mounts the real title bar without renderer errors')
    assert.equal(await run(`document.querySelector('[data-tab-id="1"] .tab-activity')?.dataset.state`), 'working', 'remote tabs draw activity dots too')
    // Nothing below may read the machine's own motion setting. app.css stills
    // every dot under prefers-reduced-motion (the macOS and Windows CI legs
    // failed the pulse check from dad02b0 on), and its global reduce block's
    // `transition-duration: 1ms` turns the initial `transition-property: all`
    // into a real transition on every element, so the palette audit's
    // same-task getComputedStyle read the PREVIOUS theme's colours. So: say
    // what this machine reports, pin 'no-preference' for the whole run, and
    // emulate 'reduce' only for the checks about it. Rehearse a runner with
    // `electron --force-prefers-reduced-motion` (gotcha 113): it must pass both.
    const motion = win.webContents.debugger
    motion.attach('1.3')
    const emulateMotion = (value: 'reduce' | 'no-preference') => motion.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] })
    const reducedHere = await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
    console.log(`this machine reports prefers-reduced-motion: ${reducedHere ? 'reduce' : 'no-preference'} (the run emulates each value, so neither decides it)`)
    await emulateMotion('reduce')
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true, 'the reduce emulation took')
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-activity')).animationName`), 'none', 'a working dot stays still under reduced motion')
    await emulateMotion('no-preference')
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false, 'the no-preference emulation took')
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-activity')).animationName`), 'activity-pulse')
    await run(`document.querySelector('[data-tab-id="1"] .tab-activity').dataset.state='waiting'`)
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-activity')).animationName`), 'none', 'blocking questions use a solid dot')
    assert.equal(await run(`document.querySelectorAll('.tab-agent,.tab-agent-rule,.ring-remote').length`), 0, 'agent tags and remote arrows are gone');
    assert.equal(await run(`document.querySelector('[data-tab-id="0"]').dataset.agent`), 'claude', 'the default agent has a coloured top edge too');
    assert.equal(await run(`document.querySelector('[data-tab-id="1"] .ring').dataset.level`), 'low', 'remote context uses the same meter as local context');
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-remote-dot')).animationName`), 'remote-connection-pulse');
    for (const style of ['solid', 'dotted']) {
      await run(`window.setRingStyle('${style}')`); await settle();
      const tracks = await run(`[0,1,2].map(id=>{const tab=document.querySelector('[data-tab-id="'+id+'"]');return {track:getComputedStyle(tab.querySelector('.ring-track')).stroke,bead:getComputedStyle(tab.querySelector('.ring-bead')).display}})`);
      assert.equal(tracks[0].track, tracks[1].track); assert.equal(tracks[1].track, tracks[2].track);
      assert.ok(tracks.every(t => style === 'dotted' ? t.track === 'none' && t.bead !== 'none' : t.track !== 'none' && t.bead === 'none'), JSON.stringify(tracks));
    }
    await run(`window.setRemoteUsed(150000)`); await settle();
    assert.equal(await run(`document.querySelector('[data-tab-id="1"] .ring').dataset.level`), 'high', 'remote context updates after the initial reading');
    await run(`window.setRemoteState('reconnecting')`); await settle();
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-remote-dot')).animationName`), 'none', 'a lost link never continues pulsing as connected');
    await run(`window.setRemoteState('open');window.setRemoteUsed(50000);window.setRingStyle('solid')`); await settle();
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-remote-dot')).animationName`), 'remote-connection-pulse', 'a restored link pulses again');
    await emulateMotion('reduce');
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-tab-id="1"] .tab-remote-dot')).animationName`), 'none', 'remote dot respects reduced motion');
    await emulateMotion('no-preference');
    const palette = await run(`window.themes.map(id=>{window.setTheme(id);return [id,[0,1].map(n=>getComputedStyle(document.querySelector('[data-tab-id="'+n+'"]'),'::before').backgroundColor), (()=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');const rgb=color=>{x.clearRect(0,0,1,1);x.fillStyle=color;x.fillRect(0,0,1,1);const [r,g,b,a]=x.getImageData(0,0,1,1).data;return {r,g,b,a:a/255}};return {inks:[0,1].map(n=>rgb(getComputedStyle(document.querySelector('[data-tab-id="'+n+'"]'),'::before').backgroundColor)),grounds:['--bg','--bg-sunken','--surface-hover'].map(key=>rgb(getComputedStyle(document.documentElement).getPropertyValue(key)))}})()]})`);
    for (const [id, , audit] of palette) for (const ink of audit.inks) for (const ground of audit.grounds) assert.ok(contrastRatio(ink, ground) >= 3, 'tab edge contrast on ' + id);
    assert.ok(palette.every(([,colors])=>colors[0]!==colors[1]), 'Claude orange and Codex purple remain distinct on every theme');
    assert.ok(new Set(palette.map(([,colors])=>colors[1])).size > 2, 'agent colours adapt to the theme');
    await run(`window.setTheme('ember');window.setSessionTabs(false)`); await settle();
    for (const scale of [16, 25.6]) {
      await run(`document.documentElement.style.fontSize = '${scale}px'; window.setActive('0')`)
      await settle()
      assert.equal(await run(`!!document.querySelector('[aria-label="Scroll session tabs"]')`), true)
      // At 25.6px this follows the previous pass's setActive('0') scrolling back.
      await until(`document.querySelector('[aria-label="Scroll tabs left"]').disabled`, 'the left button never disabled at the start of the strip', () => run(`({scale: ${scale}, left: document.querySelector('.tablist').scrollLeft})`))
      assert.equal(await run(`(() => { const tabs = document.querySelector('.tabs').getBoundingClientRect(), actions = document.querySelector('.titlebar-actions').getBoundingClientRect(); return tabs.right <= actions.left && actions.right <= innerWidth - 140; })()`), true, 'usage and native controls have reserved space')
      assert.equal(await run(`getComputedStyle(document.querySelector('.usage-mini-track')).display`), 'none', 'compact usage hides the mini bar while preserving labels and percentages')
      assert.ok(await run(`document.querySelector('.usage-mini-left').textContent.includes('60')`))
      const before = await run(`document.querySelector('.tablist').scrollLeft`)
      await run(`document.querySelector('[aria-label="Scroll tabs right"]').click()`)
      await settle()
      assert.ok(await run(`document.querySelector('.tablist').scrollLeft`) > before, 'right button advances the strip')
      const strip = () => run(`({left: document.querySelector('.tablist').scrollLeft, disabled: document.querySelector('[aria-label="Scroll tabs left"]').disabled, width: document.querySelector('.tablist').clientWidth})`)
      // The press that brings a tab back: the left button must come alive once the strip has moved.
      await until(`!document.querySelector('[aria-label="Scroll tabs left"]').disabled`, 'the left button never enabled after the right button scrolled the strip', async () => ({ scale, before, afterRight: await strip() }))
      const afterRight = await strip()
      await run(`document.querySelector('[aria-label="Scroll tabs left"]').click()`)
      await until(`document.querySelector('.tablist').scrollLeft < ${afterRight.left}`, 'the left button never moved the strip back', async () => ({ scale, before, afterRight, afterLeft: await run(`document.querySelector('.tablist').scrollLeft`) }))
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
      const geometry = await run(`(() => { const list=document.querySelector('.tablist').getBoundingClientRect(), tab=document.querySelector('[aria-selected="true"]').getBoundingClientRect(); return {list: {left:list.left,right:list.right}, tab: {left:tab.left,right:tab.right}, selected: document.querySelector('[aria-selected="true"]').dataset.tabId, scroll: {left:document.querySelector('.tablist').scrollLeft,width:document.querySelector('.tablist').scrollWidth,client:document.querySelector('.tablist').clientWidth},app:document.querySelector('.app').scrollLeft,body:document.body.scrollLeft}; })()`)
      assert.ok(geometry.tab.right <= geometry.list.right + 1 && geometry.tab.left >= geometry.list.left - 1, 'selected last tab is fully visible: ' + JSON.stringify({ scale, ...geometry }))
      await until(`document.querySelector('[aria-label="Scroll tabs right"]').disabled`, 'the right button never disabled with the last tab in view', () => run(`({scale: ${scale}, left: document.querySelector('.tablist').scrollLeft, max: document.querySelector('.tablist').scrollWidth - document.querySelector('.tablist').clientWidth})`))
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
    await run(`window.setCount(3);window.setSessionTabs(true)`); await settle();
    writeFileSync(resolve('out/tab-appearance.png'), (await captureTestWindow(win)).toPNG());
    await motion.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), reducedHere, 'the emulation is cleared back to this machine’s own setting');
    motion.detach();
    console.log('PASS real title bar: theme-aware agent edges, shared ring styles, remote context/link states, reduced motion, overflow, zoom and usage clearance.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
