/** Production EmbeddedBrowser with an Electron event fixture. This proves
 * the embedder contract; the packaged CI probe proves Chromium behavior. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export async function browserPopupChecks(check: (name: string, got: unknown, want: unknown) => void): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'stoke-browser-popups-'))
  try {
    const bundle = join(work, 'browser.cjs')
    await build({ stdin: { contents: "export {EmbeddedBrowser} from './src/main/browser.ts'; export {mock} from 'electron'", resolveDir: resolve('.') }, outfile: bundle, platform: 'node', format: 'cjs', bundle: true,
      plugins: [{ name: 'electron-popup-fixture', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'popup-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'popup-fixture' }, () => ({ loader: 'js', contents: `
          import {EventEmitter} from 'node:events';
          let sequence=0;
          export class Contents extends EventEmitter {
            id=++sequence; url=''; destroyed=false; loads=[];
            navigationHistory={canGoBack:()=>false, canGoForward:()=>false};
            getURL(){return this.url} getTitle(){return this.url} isLoading(){return false} getZoomLevel(){return 0}
            isDestroyed(){return this.destroyed} setWindowOpenHandler(fn){this.popup=fn}
            loadURL(url, options){this.loads.push({url,options});return Promise.resolve()}
            close(){this.destroy()} destroy(){this.destroyed=true;this.emit('destroyed')}
          }
          export class WebContentsView {
            constructor(options){this.options=options;this.contents=options.webContents||new Contents()}
            get webContents(){return this.contents.destroyed?undefined:this.contents}
            setBackgroundColor(){} setBounds(bounds){this.bounds=bounds} setVisible(visible){this.visible=visible}
          }
          const jar={setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onCompleted(){},onErrorOccurred(){}}};
          export const session={fromPartition:()=>jar}, shell={};
          export const mock={Contents,window:()=>({isDestroyed:()=>false,contentView:{
            children:[],addChildView(view){this.children.push(view)},removeChildView(view){
              if(!view.webContents)throw Error('native view already destroyed');
              this.children=this.children.filter(v=>v!==view)
            }
          }})};
        ` }))
      } }] })
    const { EmbeddedBrowser, mock } = createRequire(import.meta.url)(bundle)
    const win = mock.window()
    const browser = new EmbeddedBrowser(win, () => {})
    browser.show('https://example.test/initial')
    const opener = browser.webContents()
    browser.show()
    check('show during the first uncommitted link load never replaces it with about:blank', opener.loads.map((l: { url: string }) => l.url), ['https://example.test/initial'])
    check('new browser pages are mounted before being hidden with a real viewport', [win.contentView.children.length, win.contentView.children[0].bounds.width > 0], [1, true])
    const sourceId = browser.currentState().activeId
    const details = { url: 'about:blank', disposition: 'new-window', referrer: { url: 'https://example.test/source', policy: 'default' } }
    const decision = opener.popup(details)
    const guest = new mock.Contents()
    const adopted = decision.createWindow({ webContents: guest, webPreferences: { nodeIntegration: true, sandbox: false, partition: 'wrong' } })
    check('popup adopts exactly Chromium\'s existing guest without restarting its navigation', [decision.action, adopted === guest, guest.loads.length], ['allow', true, 0])
    const prefs = win.contentView.children.at(-1).options.webPreferences
    check('popup profile and sandbox cannot be replaced by creation preferences', [prefs.partition, prefs.nodeIntegration, prefs.sandbox, prefs.contextIsolation, prefs.webSecurity], ['persist:stoke-browser', false, true, true, true])
    guest.destroy()
    check('self-closing popup removes metadata after Electron clears the page getter', [browser.currentState().tabs.length, browser.currentState().activeId], [1, sourceId])
    const background = opener.popup({ ...details, url: 'https://example.test/link', disposition: 'background-tab' }).createWindow({})
    check('guest-less background navigation loads once and preserves referrer and selection', [background.loads, browser.currentState().activeId], [[{ url: 'https://example.test/link', options: { httpReferrer: details.referrer } }], sourceId])
    const bytes = Buffer.from('note=Unicode+%E7%95%8C')
    const post = opener.popup({ ...details, url: 'https://example.test/post', postBody: { data: [{ type: 'rawData', bytes }], contentType: 'multipart/form-data', boundary: 'probe-boundary' } }).createWindow({})
    check('guest-less popup form retains its exact POST bytes and multipart boundary', [post.loads[0].options.postData[0].bytes.equals(bytes), post.loads[0].options.extraHeaders, post.loads[0].options.httpReferrer], [true, 'content-type: multipart/form-data; boundary=probe-boundary', details.referrer])
    const before = browser.currentState().tabs.length
    check('local-file popup request is denied before any tab is created', [opener.popup({ ...details, url: 'file:///etc/passwd' }).action, browser.currentState().tabs.length], ['deny', before])
    let prevented = false
    post.emit('will-navigate', { url: 'file:///etc/passwd', preventDefault: () => { prevented = true } })
    check('later page-driven popup navigation cannot become a local file', prevented, true)
    browser.destroy()
    check('closing the browser releases every remaining owned page', [opener.destroyed, background.destroyed, post.destroyed, browser.currentState().tabs.length], [true, true, true, 0])
  } finally { await rm(work, { recursive: true, force: true }) }
}
