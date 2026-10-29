import { captureTestWindow } from './capture-test-window.mts'
/** Real browser keyboard/draft lifecycle plus adversarial storage journals. */
import { app, BrowserWindow, session } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { DraftJournal, legacyRemoteDraft, markLegacyDraftRestored, splitLegacyDraft, unmarkLegacyDraftRestored, DRAFT_TTL, DRAFT_MAX, type DraftStorage } from '../src/remote/draftCache.ts'

class MemoryStorage implements DraftStorage {
  data = new Map<string, string>(); fail = false; writes = 0
  get length() { return this.data.size }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { if (this.fail) throw new Error('QuotaExceededError'); this.writes++; this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}
function journals(): void {
  const storage = new MemoryStorage(); let now = 1000
  const open = (scope: string, id: string) => new DraftJournal(storage, scope, () => now, id)
  const first = open('local:session', 'a'); first.initial(); first.save('你好 👋\n unfinished ')
  const restored = open('local:session', 'b'); assert.equal(restored.initial()?.text, '你好 👋\n unfinished ')
  first.save('a newer edit in the first tab')
  restored.save('independent edit in the second tab')
  assert.ok(restored.recoveries().some((r) => r.text === 'a newer edit in the first tab'), 'a concurrent editor is never overwritten')
  restored.clear()
  assert.equal(open('local:session', 'c').initial()?.kind, 'cleared', 'clearing does not resurrect an older draft')
  assert.ok(open('local:session', 'c').recoveries().some((r) => r.text === 'a newer edit in the first tab'), 'other tabs remain manually recoverable')
  const separate = open('local:session.extra', 'x'); separate.save('other session')
  assert.ok(first.records().every((r) => r.text !== 'other session'), 'prefix-sharing scope names are isolated')
  const remote = open('device:remote:session', 'x'); assert.equal(remote.initial(), null)
  assert.ok(remote.recoveries(true).some((r) => r.text === 'other session'), 'a new terminal can manually recover another session’s draft without auto-restoring it')
  const queued = open('queue', 'a'); queued.archiveQueued('offline prompt')
  assert.equal(open('queue', 'b').initial(), null, 'saved queued messages never become automatic sends or auto-restores')
  assert.equal(queued.recoveries()[0].kind, 'queued')
  const old = queued.recoveries()[0]
  queued.save('current unsent text'); queued.restore(old, 'current unsent text')
  assert.ok(queued.recoveries().some((r) => r.text === 'current unsent text'), 'restoring backs up current text first')
  storage.setItem(first.prefix + 'broken', '{no json')
  assert.ok(first.records().length > 0, 'one malformed record cannot block recovery')
  const oldRemote = open('remote-recovery', 'old'); oldRemote.save('same session draft')
  const otherRemote = open('remote-recovery-other', 'other'); otherRemote.save('different session')
  const writes = storage.writes
  const recovered = legacyRemoteDraft(storage, 'remote-recovery', now)!
  assert.equal(recovered.text, 'same session draft', 'recovery stays within its session')
  assert.equal(storage.writes, writes, 'looking up a draft does not rewrite it')
  markLegacyDraftRestored(storage, 'remote-recovery', recovered)
  assert.equal(legacyRemoteDraft(storage, 'remote-recovery', now), null, 'a restored revision is not inserted again on reopen')
  assert.equal(oldRemote.records()[0].text, 'same session draft', 'the original saved draft remains intact')
  unmarkLegacyDraftRestored(storage, 'remote-recovery', recovered)
  assert.equal(legacyRemoteDraft(storage, 'remote-recovery', now)?.text, 'same session draft', 'a known-unsent attempt may be tried again')
  assert.deepEqual(splitLegacyDraft('abc👋def', 4), ['abc', '👋de', 'f'], 'long drafts split without breaking an emoji')
  assert.deepEqual(splitLegacyDraft('abc\r\ndef', 4), ['abc', '\r\nde', 'f'], 'long drafts do not split a CRLF newline')
  oldRemote.clear()
  assert.equal(legacyRemoteDraft(storage, 'remote-recovery', now), null, 'cleared drafts stay cleared')
  assert.throws(() => first.save('x'.repeat(DRAFT_MAX + 1)))
  storage.fail = true
  assert.throws(() => first.save('cannot save'))
  assert.equal(storage.getItem(first.key)?.includes('a newer edit'), true, 'failed writes preserve the previous checkpoint')
  storage.fail = false
  now += DRAFT_TTL + 100
  assert.equal(first.records().length, 0, 'expired text is removed after 14 days')
  console.log('PASS draft journal: Unicode, concurrent editors, clears, device/session isolation, queued recovery, malformed records, limits, quota and expiry.')
}

async function main(): Promise<void> {
  mkdirSync('out', { recursive: true })
  const temp = mkdtempSync(resolve('out/remote-composer-'))
  let win: BrowserWindow | undefined
  try {
    journals()
    const entry = join(temp, 'fixture.ts')
    writeFileSync(entry, `
import { mountTerminalKeys } from ${JSON.stringify(resolve('src/remote/terminalKeyBar.ts'))};
import { DraftJournal, mountDraftCache } from ${JSON.stringify(resolve('src/remote/draftCache.ts'))};
import ${JSON.stringify(resolve('src/remote/style.css'))};
const sent = [], keyboardAbort = new AbortController();
const keyboard = mountTerminalKeys(document.getElementById('keys'), { write: value => {sent.push(value); return true}, applicationCursorMode: () => false, signal: keyboardAbort.signal }); keyboard.setEnabled(true);
const input = document.getElementById('composer'); let abort, cache, state;
const scope = 'test-session';
function mount(journal = new DraftJournal(localStorage, scope)) { abort = new AbortController(); cache = mountDraftCache(input, journal, {signal:abort.signal, notify:(value, records)=>{state=value; document.getElementById('status').textContent=value}}); }
mount();
window.test = {sent, keyboard, input, get cache(){return cache}, get state(){return state}, get abort(){return abort}, mount, keyboardAbort};
`)
    await build({ configFile: false, logLevel: 'error', resolve: { alias: { '@shared': resolve('src/shared') } }, build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry, name: 'fixture', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' } } })
    writeFileSync(join(temp, 'index.html'), '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="bundle/fixture.css"><div style="padding:8px"><div class="keys" id="keys"></div><textarea id="composer" style="width:100%;margin-top:12px"></textarea><span id="status"></span></div><script src="bundle/fixture.js"></script>')
    const partition = session.fromPartition(`composer-${Date.now()}`)
    win = new BrowserWindow({ width: 390, height: 844, show: process.platform === 'linux', webPreferences: { backgroundThrottling: false, session: partition } })
    const errors: string[] = []
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    await win.loadFile(join(temp, 'index.html'))
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    const run = (script: string) => win!.webContents.executeJavaScript(script)
    const wait = (ms = 60) => new Promise((done) => setTimeout(done, ms))
    /** Polls a page condition until it holds or `ms` passes; the assertion after it reports. */
    const until = async (script: string, ms: number): Promise<void> => { const end = Date.now() + ms; while (!(await run(script)) && Date.now() < end) await wait(25) }
    await wait()
    assert.equal(await run(`document.querySelector('.keys-panel').hidden`), true)
    assert.equal(await run(`document.querySelectorAll('.keys-quick > button').length`), 6)
    for (const width of [320, 390, 844]) {
      win.setSize(width, width === 844 ? 390 : 844); await wait()
      await run(`test.input.focus(); document.querySelector('.key-more-toggle').click()`)
      assert.equal(await run(`document.querySelector('.keys-panel').hidden`), false)
      for (let group = 0; group < 4; group++) {
        await run(`document.querySelectorAll('.keys-tabs button')[${group}].click()`)
        assert.equal(await run(`Array.from(document.querySelectorAll('.keys-page')).filter(page => !page.hidden).length`), 1)
        assert.equal(await run(`document.getElementById('keys').scrollWidth <= document.getElementById('keys').clientWidth + 1`), true, 'no sideways key scroller')
        assert.equal(await run(`document.querySelector('.keys-quick').getBoundingClientRect().right <= innerWidth`), true)
      }
      await run(`document.querySelector('.key-more-toggle').click()`)
    }
    win.setSize(390, 844)
    await run(`document.querySelector('.key-more-toggle').click(); document.querySelector('[data-key="Shift"]').click(); document.querySelectorAll('.keys-tabs button')[0].click(); document.querySelector('[data-key="ArrowLeft"]').click()`)
    assert.equal(await run('test.sent.at(-1)'), '\x1b[1;2D')
    assert.equal(await run(`document.querySelector('[data-key="Shift"]').getAttribute('aria-pressed')`), 'false')
    await run(`document.querySelector('[data-key="Shift"]').click(); document.querySelectorAll('.keys-tabs button')[2].click(); document.querySelector('[data-key="F2"]').click()`)
    assert.equal(await run('test.sent.at(-1)'), '\x1b[1;2Q')
    await run(`document.querySelector('[data-key="Ctrl"]').click();document.querySelector('[data-key="Ctrl"]').click();document.querySelectorAll('.keys-tabs button')[0].click();document.querySelector('[data-key="ArrowLeft"]').click()`)
    assert.equal(await run(`document.querySelector('[data-key="Ctrl"]').dataset.state`), 'locked')
    assert.equal(await run('test.sent.at(-1)'), '\x1b[1;5D')
    await run(`document.querySelector('[data-key="Ctrl"]').click()`)
    await run(`document.querySelectorAll('.keys-tabs button')[1].click(); document.querySelector('[data-key="Ctrl+C"]').click()`)
    assert.equal(await run('test.sent.at(-1)'), '\x03')
    assert.equal(await run('document.activeElement === test.input'), true, 'taps retain composer focus')
    await run(`document.querySelectorAll('.keys-tabs button')[3].click(); document.querySelector('.key-eof').click()`)
    assert.notEqual(await run('test.sent.at(-1)'), '\x04', 'Ctrl+D needs confirmation')
    await wait(370)
    await run(`document.querySelector('.key-eof').click()`)
    assert.equal(await run('test.sent.at(-1)'), '\x04')
    await run(`test.keyboard.setEnabled(false); document.querySelector('[data-key="Enter"]').click()`)
    const count = await run('test.sent.length')
    await run(`document.querySelector('[data-key="Tab"]').click()`)
    assert.equal(await run('test.sent.length'), count, 'disconnected controls cannot send')
    await run(`test.keyboard.setEnabled(true); document.querySelector('.key-more-toggle').click()`)
    writeFileSync(resolve('out/remote-keyboard.png'), (await captureTestWindow(win)).toPNG())

    await run(`test.input.value='123456789';test.input.dispatchEvent(new InputEvent('input',{data:'123456789'}))`)
    assert.equal(await run(`localStorage.length`), 0, 'short edits coalesce before the checkpoint')
    await run(`test.input.value+='0';test.input.dispatchEvent(new InputEvent('input',{data:'0'}))`)
    assert.equal(await run(`JSON.parse(localStorage.getItem(localStorage.key(0))).text`), '1234567890')
    // A short edit waits for the 500 ms idle checkpoint (mountDraftCache). Read
    // in the SAME task as the edit, so the timer cannot have fired yet, then
    // poll: a fixed wait(550) left a loaded runner 50 ms of slack, and the
    // macOS leg failed here reading the old '1234567890'.
    assert.equal(await run(`test.input.value+='短';test.input.dispatchEvent(new InputEvent('input',{data:'短'}));JSON.parse(localStorage.getItem(localStorage.key(0))).text`), '1234567890', 'a short edit is not saved at once')
    await until(`JSON.parse(localStorage.getItem(localStorage.key(0))).text === '1234567890短'`, 3000)
    assert.equal(await run(`JSON.parse(localStorage.getItem(localStorage.key(0))).text`), '1234567890短', 'idle saves shorter edits')
    await run(`test.input.dispatchEvent(new CompositionEvent('compositionstart'));test.input.value+='候補';test.input.dispatchEvent(new InputEvent('input',{data:'候補',isComposing:true}));window.dispatchEvent(new Event('pagehide'))`)
    assert.equal(await run(`JSON.parse(localStorage.getItem(localStorage.key(0))).text`), '1234567890短', 'uncommitted IME candidates are not saved')
    await run(`test.input.dispatchEvent(new CompositionEvent('compositionend'))`)
    assert.equal(await run(`JSON.parse(localStorage.getItem(localStorage.key(0))).text`), '1234567890短候補')
    await run(`test.input.value+='b';test.input.dispatchEvent(new InputEvent('input',{data:'b'}));test.input.dispatchEvent(new Event('blur'))`)
    assert.equal(await run(`JSON.parse(localStorage.getItem(localStorage.key(0))).text`), '1234567890短候補b')
    await run(`test.input.value+='!';test.input.dispatchEvent(new InputEvent('input',{data:'!'}));window.dispatchEvent(new Event('pagehide'))`)
    win.webContents.reload(); await new Promise<void>((done) => win!.webContents.once('did-finish-load', () => done()))
    assert.equal(await run('test.input.value'), '1234567890短候補b!')
    assert.equal(await run('test.sent.length'), 0, 'recovery never sends anything')
    assert.equal(await run('test.state'), 'restored')
    await run(`test.cache.clear();window.dispatchEvent(new Event('pagehide'))`)
    win.webContents.reload(); await new Promise<void>((done) => win!.webContents.once('did-finish-load', () => done()))
    assert.equal(await run('test.input.value'), '', 'sent/deleted drafts remain cleared after reload')
    await run(`test.abort.abort();test.mount(null);test.input.value='still editable';test.input.dispatchEvent(new InputEvent('input',{data:'still editable'}))`)
    assert.equal(await run('test.state'), 'error', 'blocked storage is visible without breaking editing')
    assert.equal(await run('test.input.value'), 'still editable')
    assert.deepEqual(errors, [])
    console.log('PASS browser keyboard: compact/grouped layouts, modifiers, shortcuts, protected EOF, focus and disconnect guards; draft checkpoints, IME, reload recovery, no replay and storage failure.')
    await partition.clearStorageData()
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { win?.destroy(); rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode ? Number(process.exitCode) : 0) }
}
app.on('window-all-closed', () => {})
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
