import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'vite'

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/shell-layout-'))
  let win: BrowserWindow | undefined
  try {
    const entry = join(temp, 'fixture.tsx')
    writeFileSync(entry, `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {QuickTerminalPanel} from ${JSON.stringify(resolve('src/renderer/src/components/QuickTerminal.tsx'))};
import {UsageChip} from ${JSON.stringify(resolve('src/renderer/src/components/UsageMeter.tsx'))};
import {applyTheme} from ${JSON.stringify(resolve('src/renderer/src/lib/theme.ts'))};
import {EMBER} from ${JSON.stringify(resolve('src/shared/themes.ts'))};
import {TERMINAL_DEFAULTS} from ${JSON.stringify(resolve('src/shared/ui.ts'))};
import ${JSON.stringify(resolve('src/renderer/src/styles/app.css'))};
applyTheme(EMBER);document.documentElement.dataset.agentPaint='true';document.documentElement.dataset.termFrame='true';
const noop=()=>{};const windows=[{kind:'session',label:'5 hours',percent:40,severity:'normal',resetsAt:Date.now()+3600000,elapsed:.2,active:true},{kind:'weekly',label:'Weekly',percent:25,severity:'normal',resetsAt:Date.now()+6*86400000,elapsed:.3,active:true}];
window.stoke={usage:{all:async()=>({readings:[{key:'anthropic:default',source:'anthropic',cli:'claude',accountId:'default',label:'Default',detail:null,snapshot:{windows,extraCredits:null,fetchedAt:Date.now(),error:null}}],activeKey:'anthropic:default',target:null})},statusLine:{last:async()=>[],onUpdate:()=>noop}};
window.stoke.usage.read=window.stoke.usage.all;
const initial={enabled:true,revision:1,id:'shell',phase:'running',mode:'panel',cwd:'/Users/me/dev/stoke',shell:'/bin/zsh',shellId:'zsh',contextId:'tab-one',pinned:false,sessions:[{id:'shell',shellId:'zsh',phase:'running'}],cols:60,rows:24,exitCode:null};
const api={platform:'darwin',read:async()=>({state:initial,sequence:0,data:'% npm run check\\r\\n✓ Typecheck passed\\r\\n✓ Remote recovery passed\\r\\n\\r\\nstoke % '}),shells:async()=>[{id:'zsh',label:'zsh',path:'/bin/zsh'},{id:'bash',label:'bash',path:'/bin/bash'}],onData:()=>noop,resize:noop,write:noop,copy:noop,paste:async()=>'',openLink:noop,move:async()=>({ok:true,state:initial}),pin:async(pinned)=>{window.pinCalled=pinned;return {ok:true,state:initial}},end:async()=>({ok:true,state:initial})};
function Fixture(){return <><div className="fixture-top"><span>Stoke · remote workspace</span><UsageChip target={null}/></div><div className="fixture-body"><div className="fixture-main"><div className="term-pane" data-agent="codex" style={{'--agent-ink':'#cc95fa'}}><div className="term-host"><pre className="fixture-output">{'› Improve remote connectivity across my computers\\n\\n  Working…\\n\\n  MacBook · Work desktop · PC'}</pre></div></div></div><div className="fixture-dock"><QuickTerminalPanel api={api} state={initial} appearance={{theme:EMBER,fontFamily:'monospace',fontSize:13,uiScale:1,terminal:TERMINAL_DEFAULTS}} surface="panel"/></div></div></>};
createRoot(document.getElementById('root')).render(<Fixture/>);`)
    await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@shared': resolve('src/shared') } }, esbuild: { jsx: 'automatic' }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="bundle/fixture.css"><style>.fixture-top{height:3rem;display:flex;align-items:center;justify-content:space-between;padding:0 1rem;border-bottom:1px solid var(--border-subtle)}.fixture-body{display:flex;height:calc(100vh - 3rem)}.fixture-main{flex:1;min-width:0;position:relative}.fixture-dock{display:flex;width:400px;border-left:1px solid var(--border-subtle)}.fixture-output{margin:0;padding:16px;font:13px/1.8 monospace;color:var(--text)}</style><div id="root"></div><script src="bundle/fixture.js"></script>')
    win = new BrowserWindow({ width: 1100, height: 640, show: false, webPreferences: { backgroundThrottling: false } })
    const errors: string[] = []
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
    await win.loadFile(join(temp, 'index.html'))
    const run = (code: string) => win!.webContents.executeJavaScript(code)
    const settle = () => new Promise(done => setTimeout(done, 120))
    await settle()
    assert.deepEqual(errors, [])
    assert.equal(await run(`getComputedStyle(document.querySelector('.term-host')).getPropertyValue('--pane-agent-rule').trim()`), '', 'terminal has no coloured top stripe')
    assert.ok(await run(`document.querySelector('[data-kind="weekly"] .usage-mini-reset').textContent.includes('d')`), 'weekly reset appears in the chip')
    assert.ok(await run(`document.querySelector('.usage-chip').title.includes('Weekly: 75% left, resets')`), 'weekly reset is also available in the tooltip')
    for (const scale of [16, 25.6]) for (const width of [300, 400, 640]) {
      await run(`document.documentElement.style.fontSize='${scale}px';document.querySelector('.fixture-dock').style.width='${width}px'`); await settle()
      assert.ok(await run(`document.querySelector('.quick-terminal').scrollWidth <= document.querySelector('.quick-terminal').clientWidth + 1`), `shell controls fit ${width}px at ${scale}px scale`)
      assert.ok(await run(`document.querySelector('.quick-terminal-screen').clientHeight > 300`), 'the shell retains useful output space')
      assert.ok(await run(`Array.from(document.querySelectorAll('.quick-terminal-header button,.quick-terminal-header select')).every(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('.quick-terminal').getBoundingClientRect();return r.width>0&&r.left>=p.left&&r.right<=p.right+1})`), 'all controls remain reachable')
    }
    await run(`document.documentElement.style.fontSize='16px';document.querySelector('.fixture-dock').style.width='400px';document.querySelector('[aria-label="Keep terminal across tabs"]').click()`); await settle()
    assert.equal(await run('window.pinCalled'), true, 'compact pin control retains its action')
    await run(`document.querySelector('.usage-chip').click()`); await settle()
    assert.ok(await run(`Array.from(document.querySelectorAll('.usage-row')).every(row=>{const pct=row.querySelector('.usage-pct'),reset=row.querySelector('.usage-reset');return !pct||!reset||pct.getBoundingClientRect().right<=reset.getBoundingClientRect().left+1})`), 'used labels and reset times do not overlap in the expanded panel')
    await run(`document.querySelector('.usage-chip').click()`); await settle()
    writeFileSync(resolve('out/stoke-shell-layout.png'), (await win.webContents.capturePage()).toPNG())
    console.log('PASS shell layout: quiet terminal frame, weekly reset, shell density at 300/400/640px and 100/160% scale, reachable controls and pinning.')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1) })
