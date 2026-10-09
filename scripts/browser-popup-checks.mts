/** Production EmbeddedBrowser with an Electron event fixture. This proves
 * the embedder contract; the packaged CI probe proves Chromium behavior. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { createCertificate } from './probe/tls-server.mjs'
import { readFileSync } from 'node:fs'

export async function browserPopupChecks(check: (name: string, got: unknown, want: unknown) => void): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'stoke-browser-popups-'))
  try {
    const bundle = join(work, 'browser.cjs')
    await build({ stdin: { contents: "export {EmbeddedBrowser} from './src/main/browser.ts'; export {PageAgent} from './src/main/mcp/page.ts'; export {mock} from 'electron'", resolveDir: resolve('.') }, outfile: bundle, platform: 'node', format: 'cjs', bundle: true,
      plugins: [{ name: 'electron-popup-fixture', setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, args => ({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw-fixture'}))
        builder.onLoad({ filter: /.*/, namespace: 'raw-fixture' }, args => ({loader:'text',contents:readFileSync(args.path,'utf8')}))
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'popup-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'popup-fixture' }, () => ({ loader: 'js', contents: `
          import {EventEmitter} from 'node:events';
          let sequence=0;
          export class Contents extends EventEmitter {
            id=++sequence; url=''; destroyed=false; loads=[];
            navigationHistory={canGoBack:()=>false, canGoForward:()=>false};
            getURL(){return this.url} getTitle(){return this.url} isLoading(){return false} getZoomLevel(){return 0}
            isDestroyed(){return this.destroyed} setWindowOpenHandler(fn){this.popup=fn}
            loadURL(url, options){this.loads.push({url,options});return this.onLoad?.(url)||Promise.resolve()}
            reload(){this.emit('did-start-navigation', {url:this.url,isMainFrame:true,isSameDocument:false})} stop(){}
            close(){this.destroy()} destroy(){this.destroyed=true;this.emit('destroyed')}
          }
          export class WebContentsView {
            constructor(options){this.options=options;this.contents=options.webContents||new Contents()}
            get webContents(){return this.contents.destroyed?undefined:this.contents}
            setBackgroundColor(){} setBounds(bounds){this.bounds=bounds} setVisible(visible){this.visible=visible}
          }
          const jar={setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onCompleted(){},onErrorOccurred(){}}};
          export const session={fromPartition:()=>jar}, shell={};
          export const mock={Contents,window:()=>({destroyed:false,isDestroyed(){return this.destroyed},contentView:{
            children:[],addChildView(view){this.children.push(view)},removeChildView(view){
              if(!view.webContents)throw Error('native view already destroyed');
              this.children=this.children.filter(v=>v!==view)
            }
          }})};
        ` }))
      } }] })
    const { EmbeddedBrowser, PageAgent, mock } = createRequire(import.meta.url)(bundle)
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
    const closedWin = mock.window()
    const closedBrowser = new EmbeddedBrowser(closedWin, () => {})
    closedBrowser.show('https://example.test/quit')
    const live = closedBrowser.webContents()
    const cleared = live.popup(details).createWindow({})
    // Native parent teardown can clear a page before the queued destroyed
    // notification reaches JS. It is no longer legal to use the getter.
    cleared.destroyed = true
    closedWin.destroyed = true
    closedBrowser.destroy()
    check('a destroyed parent releases surviving pages and skips a cleared native getter', [live.destroyed, closedBrowser.currentState().tabs.length], [true, 0])

    const cert = createCertificate(work)
    const otherCert = createCertificate(work, 'changed')
    const certificate = (data: Buffer) => ({data: data.toString(), subjectName:'fixture', issuerName:'fixture', validStart:1, validExpiry:2})
    const errorWin = mock.window()
    const errors = new EmbeddedBrowser(errorWin, () => {})
    errors.show('https://localhost:4443/form')
    const errorPage = errors.webContents()
    const errorView = errorWin.contentView.children[0]
    const url = 'https://localhost:4443/form'
    const start = (page = errorPage, address = url) => page.emit('did-start-navigation', {url:address,isMainFrame:true,isSameDocument:false})
    const certError = (page = errorPage, address = url, data = cert.cert, main = true, error = 'net::ERR_CERT_AUTHORITY_INVALID') => {
      let prevented = false
      const answers: boolean[] = []
      page.emit('certificate-error', {preventDefault(){prevented=true}}, address, error, certificate(data), (answer: boolean) => answers.push(answer), main)
      return {get prevented(){return prevented}, answers}
    }
    start()
    errorPage.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, false)
    errorPage.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true)
    errorPage.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://stale.test', true)
    check('subframe, aborted and stale load failures do not replace the main page', [errors.currentState().loadError, errorView.visible], [undefined, true])
    errorPage.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true)
    check('a main-frame network failure exposes its actual address and hides the native blank page', [errors.currentState().loadError?.code, errors.currentState().url, errorView.visible], ['ERR_CONNECTION_REFUSED', url, false])
    errors.show()
    errors.setBounds({x:0,y:0,width:640,height:480})
    check('show and geometry changes cannot cover the error screen with the native view', errorView.visible, false)
    errors.reload()
    check('retry uses the failed address rather than the previous committed page', errorPage.loads.at(-1).url, url)
    start()
    const review = certError()
    const failure = errors.currentState().loadError
    const tabId = errors.currentState().activeId
    check('certificate review derives SHA-256 from the actual leaf and defers the original request', [review.prevented, review.answers, failure.certificate.sha256, errorView.visible], [true, [], new X509Certificate(cert.cert).fingerprint256, false])
    check('stale failure and wrong-tab approval are refused without resolving the native request', [errors.continueCertificate(tabId, 'old'), errors.continueCertificate('other', failure.id), review.answers], [false, false, []])
    errors.hide()
    check('hidden browser cannot grant a certificate exception', errors.continueCertificate(tabId, failure.id), false)
    errors.show()
    check('explicit approval resumes exactly the held request without a new GET', [errors.continueCertificate(tabId, failure.id), review.answers, errorPage.loads.length, errorView.visible], [true, [true], 2, true])
    check('a reviewed callback cannot be replayed', errors.continueCertificate(tabId, failure.id), false)
    check('same tab, origin, leaf and error reuse the reviewed exception', certError().answers, [true])
    const unreviewed = certError(errorPage, 'https://localhost:4444/asset', cert.cert, false)
    check('an unreviewed subresource is left to default denial and cannot prompt over the page', [unreviewed.prevented, unreviewed.answers, errors.currentState().loadError], [false, [], undefined])
    const newTab = errors.newTab(url)
    start(newTab.view.webContents)
    const otherReview = certError(newTab.view.webContents)
    check('another tab in the same profile has no inherited exception', otherReview.answers, [])
    errors.closeTab(newTab.id)
    check('closing a tab denies its pending native certificate request', otherReview.answers, [false])
    const newProfile = errors.newTab(url, 'another-profile')
    certError(newProfile.view.webContents)
    check('background profile cannot approve even a known failure', errors.continueCertificate(newProfile.id, failure.id), false)
    errors.closeTab(newProfile.id)
    start()
    const changed = certError(errorPage, url, otherCert.cert)
    const changedFailure = errors.currentState().loadError
    check('a rotated leaf needs a fresh review in the same tab and origin', [changed.answers, changedFailure.id !== failure.id, errors.continueCertificate(tabId, failure.id)], [[], true, false])
    start(errorPage, 'https://elsewhere.test/')
    check('navigating away denies the held request and clears its error', [changed.answers, errors.currentState().loadError, errorView.visible], [[false], undefined, true])
    start()
    const changedError = certError(errorPage, url, cert.cert, true, 'net::ERR_CERT_DATE_INVALID')
    check('a new certificate error needs review even when its fingerprint matches', changedError.answers, [])
    errors.stop()
    check('stop denies the request and disables the stale Continue button', [changedError.answers, errors.currentState().loadError.certificate.canContinue], [[false], false])
    start()
    check('revocation removes the owned tab grant', errors.revokeCertificate(tabId, new X509Certificate(cert.cert).fingerprint256), true)
    check('revoked certificate needs review again', certError().answers, [])
    errorWin.destroyed = true
    errors.destroy()
    const agentBrowser = new EmbeddedBrowser(mock.window(), () => {})
    agentBrowser.show('about:blank')
    const agentPage = agentBrowser.webContents()
    const agent = new PageAgent(agentBrowser)
    let nativeAnswer: boolean | undefined
    agentPage.onLoad = (address: string) => new Promise<void>((resolve, reject) => {
      agentPage.emit('did-start-navigation', {url:address,isMainFrame:true,isSameDocument:false})
      agentPage.emit('certificate-error', {preventDefault(){}}, address, 'net::ERR_CERT_AUTHORITY_INVALID', certificate(cert.cert), (answer: boolean) => {
        nativeAnswer = answer
        if (answer) resolve(); else reject(new Error('certificate denied'))
      }, true)
    })
    let toolError = ''
    try { await agent.open(url) } catch (error) { toolError = (error as Error).message }
    check('an agent navigation promptly reports the required user certificate review without accepting it', [toolError.includes('user must review this certificate'), nativeAnswer], [true, undefined])
    let staleRead = false
    try { agent.webContents() } catch { staleRead = true }
    check('an agent cannot read the previous document as the failed page', staleRead, true)
    agentBrowser.destroy()
    check('agent error reporting leaves the owned callback for normal browser cleanup', nativeAnswer, false)
  } finally { await rm(work, { recursive: true, force: true }) }
}
