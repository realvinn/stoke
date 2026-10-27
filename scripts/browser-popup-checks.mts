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
            edits=[]; imageCopies=[];
            undo(){this.edits.push('undo')} redo(){this.edits.push('redo')} cut(){this.edits.push('cut')} copy(){this.edits.push('copy')}
            paste(){this.edits.push('paste')} pasteAndMatchStyle(){this.edits.push('pasteAndMatchStyle')} selectAll(){this.edits.push('selectAll')}
            copyImageAt(x, y){this.imageCopies.push([x, y])}
          }
          export class WebContentsView {
            constructor(options){this.options=options;this.contents=options.webContents||new Contents()}
            get webContents(){return this.contents.destroyed?undefined:this.contents}
            setBackgroundColor(){} setBounds(bounds){this.bounds=bounds} setVisible(visible){this.visible=visible}
          }
          const jars=new Map();
          export const session={fromPartition:(partition)=>{if(!jars.has(partition))jars.set(partition,{closeAllConnections:()=>Promise.resolve(),clearStorageData:()=>Promise.resolve(),clearCache:()=>Promise.resolve(),setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onCompleted(){},onErrorOccurred(){}}});return jars.get(partition)}}, shell={};
          const menus=[], copied=[];
          export const app={isPackaged:true}, clipboard={writeText:(text)=>copied.push(text)};
          export const Menu={buildFromTemplate:(template)=>{const menu={template,popped:null,popup(options){this.popped=options}};menus.push(menu);return menu}};
          export const mock={Contents,jars,menus,copied,window:()=>({destroyed:false,isDestroyed(){return this.destroyed},contentView:{
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
    // The right-click menu (contextMenu.ts) on a docked page, through the real wiring.
    const tabsBefore = browser.currentState().tabs.length, activeBefore = browser.currentState().activeId
    const noEdit = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canEditRichly: false }
    opener.emit('context-menu', {}, { x: 4, y: 4, frame: null, isEditable: false, selectionText: '', linkURL: 'https://example.test/linked', srcURL: '', mediaType: 'none', hasImageContents: false, editFlags: noEdit })
    const menu = mock.menus.at(-1)
    const item = (label: string) => menu?.template.find((i: { label?: string }) => i.label === label)
    item('Open Link in New Tab')?.click()
    item('Copy Link Address')?.click()
    check('a docked page\'s right-click opens a link behind the current tab, in its profile, and copies its address',
      [menu?.popped?.window === win, browser.currentState().tabs.length - tabsBefore, browser.currentState().activeId === activeBefore,
        win.contentView.children.at(-1).options.webPreferences.partition, win.contentView.children.at(-1).webContents.loads[0]?.url, mock.copied.at(-1)],
      [true, 1, true, 'persist:stoke-browser', 'https://example.test/linked', 'https://example.test/linked'])
    const menusBefore = mock.menus.length
    opener.emit('context-menu', {}, { x: 4, y: 4, frame: null, isEditable: false, selectionText: '', linkURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, editFlags: noEdit })
    check('a right-click on nothing in particular shows no menu (packaged: no Inspect)', mock.menus.length, menusBefore)
    const pick = (m: { template: { label?: string; click?: () => void }[] } | undefined, label: string) => m?.template.find((i) => i.label === label)
    const rightClick = (page: { emit(...args: unknown[]): boolean }, p: Record<string, unknown>) => {
      page.emit('context-menu', {}, { x: 4, y: 4, frame: null, isEditable: false, selectionText: '', linkURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, editFlags: noEdit, ...p })
      return mock.menus.at(-1)
    }
    // A tab on another profile while Default is the one shown: the link must
    // follow the tab's profile, which the current one would not tell apart.
    const away = browser.newTab('https://example.test/away', 'another-profile', undefined, false)
    pick(rightClick(away.view.webContents, { linkURL: 'https://example.test/from-away' }), 'Open Link in New Tab')?.click()
    check('a link right-clicked on another profile\'s tab opens in that tab\'s profile, not the one shown',
      [browser.currentProfileId(), win.contentView.children.at(-1).options.webPreferences.partition, win.contentView.children.at(-1).webContents.loads[0]?.url],
      ['default', 'persist:stoke-browser-another-profile', 'https://example.test/from-away'])
    // A linked image, so an address copied from the wrong field shows.
    const imageMenu = rightClick(opener, { x: 31, y: 47, linkURL: 'https://example.test/image-link', srcURL: 'https://example.test/picture.png', mediaType: 'image', hasImageContents: true })
    pick(imageMenu, 'Copy Image')?.click()
    check('Copy Image copies the pixels under the click from the page that was right-clicked', opener.imageCopies, [[31, 47]])
    pick(imageMenu, 'Copy Image Address')?.click()
    check('Copy Image Address copies the image\'s own address, not its link\'s', mock.copied.at(-1), 'https://example.test/picture.png')
    const label = (i: { type?: string; label?: string; enabled?: boolean }) => i.type === 'separator' ? '-' : `${i.label}${i.enabled === false ? ':off' : ''}`
    const fieldMenu = rightClick(opener, { isEditable: true, selectionText: 'abc', editFlags: { ...noEdit, canCopy: true, canSelectAll: true } })
    check('a field\'s built menu enables each item from Chromium\'s edit flags', fieldMenu?.template.map(label),
      ['Undo:off', 'Redo:off', '-', 'Cut:off', 'Copy', 'Paste:off', 'Select All'])
    // Not Electron roles, which run on whichever contents has focus (a terminal,
    // say): every edit item runs its method on the page that was right-clicked.
    const allOn = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canEditRichly: true }
    const richMenu = rightClick(opener, { isEditable: true, editFlags: allOn })
    for (const i of richMenu?.template ?? []) i.click?.()
    check('each edit item runs on the right-clicked page itself, none as a focus-following role',
      [(richMenu?.template ?? []).some((i: object) => 'role' in i), opener.edits, away.view.webContents.edits],
      [false, ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'], []])
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
    errorPage.url = url
    check('a reviewed callback cannot be replayed', errors.continueCertificate(tabId, failure.id), false)
    check('same tab, origin, leaf and error reuse the reviewed exception', certError().answers, [true])
    const unreviewed = certError(errorPage, 'https://localhost:4444/asset', cert.cert, false)
    check('an unreviewed subresource is left to default denial and cannot prompt over the page', [unreviewed.prevented, unreviewed.answers, errors.currentState().loadError], [false, [], undefined])
    const newTab = errors.newTab(url)
    start(newTab.view.webContents)
    const otherReview = certError(newTab.view.webContents)
    check('another tab shares the reviewed origin and certificate in the same profile', otherReview.answers, [true])
    const pendingOther = certError(newTab.view.webContents, url, otherCert.cert)
    errors.closeTab(newTab.id)
    check('closing a tab denies its pending native certificate request', pendingOther.answers, [false])
    const newProfile = errors.newTab(url, 'another-profile')
    const profileReview = certError(newProfile.view.webContents)
    check('a separate browser profile receives no certificate permission', profileReview.answers, [])
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
    let finishReset!: () => void
    const resetGate = new Promise<void>(resolve => { finishReset = resolve })
    mock.jars.get('persist:stoke-browser').closeAllConnections = () => resetGate
    const removing = errors.revokeCertificate(tabId, new X509Certificate(cert.cert).fingerprint256)
    check('revocation refuses reentry while the connection pool is resetting', await errors.revokeCertificate(tabId, new X509Certificate(cert.cert).fingerprint256), false)
    const duringReset = certError()
    check('a new review cannot regrant permission during connection reset', errors.continueCertificate(tabId, errors.currentState().loadError.id), false)
    finishReset()
    check('revocation removes the profile grant and reconnects before retry', await removing, true)
    check('retry after connection reset denies the obsolete pending request', duringReset.answers, [false])
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

    const reopen = new EmbeddedBrowser(mock.window(), () => {})
    reopen.setProfiles([{id:'default',label:'Default'},{id:'lifecycle',label:'Fixture'}], 'lifecycle', '')
    reopen.show(url)
    const reopenPage = reopen.webContents()
    const reopenedReview = certError(reopenPage)
    const reopenedFailure = reopen.currentState().loadError
    check('the lifecycle fixture grants the reviewed profile permission', reopen.continueCertificate(reopen.currentState().activeId, reopenedFailure.id), true)
    reopen.destroy()
    const reopened = new EmbeddedBrowser(mock.window(), () => {})
    reopened.setProfiles([{id:'default',label:'Default'},{id:'lifecycle',label:'Fixture'}], 'lifecycle', '')
    reopened.show(url)
    check('window reopening retains the same profile permission until process exit', certError(reopened.webContents()).answers, [true])
    await reopened.clearProfileData('lifecycle')
    reopened.show(url)
    const clearedReview = certError(reopened.webContents())
    check('clearing a profile removes its certificate permission too', [clearedReview.answers, reopenedReview.answers], [[], [true]])
    reopened.destroy()
  } finally { await rm(work, { recursive: true, force: true }) }
}
