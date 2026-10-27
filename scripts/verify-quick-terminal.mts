import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QuickTerminal, quickTerminalEnv } from '../src/main/quickTerminal.ts'
import { discoverTerminalShells, terminalEnvironmentPath, terminalShellArgs } from '../src/main/terminalShells.ts'
import { ownedPtyExits } from '../src/main/ptyExitTracker.ts'
import { QuickTerminalReplay, quickTerminalLink } from '../src/shared/quickTerminal.ts'
import type { QuickTerminalFrame, QuickTerminalState } from '../src/shared/quickTerminal.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { LOCAL_KEYS, portableSettings } from '../src/shared/setupFile.ts'
import { addRefusal, clampTopBar, fitTopBar } from '../src/shared/topBar.ts'
import { QUICK_TERMINAL_WRITE_MAX, QuickTerminalPresses, quickTerminalCopyText, quickTerminalKey, quickTerminalPasteText, quickTerminalRightClick, quickTerminalStopsCopy, quickTerminalTakesPress, quickTerminalWrites, selectionIsBlank } from '../src/shared/quickTerminalClipboard.ts'
import type { ChordKey, PressEvent, SelectionReading } from '../src/shared/quickTerminalClipboard.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
async function until(condition: () => boolean | Promise<boolean>, limit = 5000): Promise<boolean> {
  const deadline = Date.now() + limit
  while (!await condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  return await condition()
}
async function refused(action: () => Promise<unknown>): Promise<boolean> { try { await action(); return false } catch { return true } }
const root = await mkdtemp(join(tmpdir(), 'stoke-quick-🔥-'))
let enabled = false
let preparations = 0
const states: QuickTerminalState[] = []
const frames: QuickTerminalFrame[] = []
const service = new QuickTerminal({ enabled: () => enabled, onState: state => states.push(state), onData: frame => frames.push(frame), environment: async () => { preparations++; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') } })
try {
  console.log('\nQuick terminal: defaults and the editable top bar')
  check('new and older settings always offer the terminal', [hydrateSettings({}).quickTerminal, hydrateSettings({ quickTerminal: false }).quickTerminal, hydrateSettings({ quickTerminal: 'true' }).quickTerminal], [true, true, true])
  check('legacy enabled settings remain available', hydrateSettings({ quickTerminal: true }).quickTerminal, true)
  check('the legacy flag stays machine-local for compatibility', LOCAL_KEYS.includes('quickTerminal'), true)
  check('portable settings omit the legacy terminal flag', 'quickTerminal' in portableSettings(hydrateSettings({ quickTerminal: true })), false)
  const bar = clampTopBar({ enabled: true, items: [{ id: 'one', kind: 'terminal', command: 'never execute this' }, { id: 'two', kind: 'terminal' }] })
  check('a single terminal item carries no executable text', bar.items, [{ id: 'one', kind: 'terminal' }])
  check('a second terminal is refused', addRefusal('terminal', bar.items) !== null, true)
  const fit = fitTopBar({ room: 60, gap: 4, fixed: 20, more: 20, items: [{ id: 'one', kind: 'terminal', full: 90, compact: 90 }] })
  check('a narrow top bar keeps the terminal in its actionable overflow', fit.overflow, ['one'])

  console.log('\nQuick terminal: copy and paste')
  const key = (over: Partial<ChordKey>): ChordKey => ({ type: 'keydown', key: 'c', code: 'KeyC', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })
  const picked: SelectionReading = { text: 'npm run check', any: true }
  const blank: SelectionReading = { text: '', any: true }
  const unselected: SelectionReading = { text: '', any: false }
  // What xterm's getSelection reads for blank cells over several rows: trimmed
  // rows joined by '\n' ('\r\n' on Windows), and a full-screen program's
  // painted background as written spaces, which the trim keeps.
  const blankRows: SelectionReading[] = [{ text: '\n', any: true }, { text: '\r\n\r\n', any: true }, { text: ' '.repeat(10) + '\n' + ' '.repeat(10), any: true }]
  const keyAct = (over: Partial<ChordKey>, isMac: boolean, selection = picked) => quickTerminalKey(key(over), isMac, () => selection)
  const copied = { kind: 'copy', text: 'npm run check' }, pasted = { kind: 'paste' }, passed = { kind: 'pass' }
  check('Cmd+C on macOS and Ctrl+Shift+C elsewhere copy the selection', [keyAct({ metaKey: true }, true), keyAct({ ctrlKey: true, shiftKey: true, key: 'C' }, false)], [copied, copied])
  check('Cmd+V and Ctrl+Shift+V paste', [keyAct({ metaKey: true, key: 'v', code: 'KeyV' }, true), keyAct({ ctrlKey: true, shiftKey: true, key: 'V', code: 'KeyV' }, false)], [pasted, pasted])
  check('bare Ctrl+C and Ctrl+V stay the shell’s interrupt and literal-next keys', [keyAct({ ctrlKey: true }, false), keyAct({ ctrlKey: true, key: 'v', code: 'KeyV' }, false), keyAct({ ctrlKey: true }, true)], [passed, passed, passed])
  check('a Cyrillic layout still copies and pastes (the letter is the key’s position)', [keyAct({ metaKey: true, key: 'с' }, true), keyAct({ ctrlKey: true, shiftKey: true, key: 'М', code: 'KeyV' }, false)], [copied, pasted])
  check('a Latin layout keeps the letter printed on the key (Dvorak)', [keyAct({ metaKey: true, key: 'c', code: 'KeyI' }, true), keyAct({ metaKey: true, key: 'j', code: 'KeyC' }, true)], [copied, passed])
  check('a copy of a blank-cell selection swallows the key and writes nothing', keyAct({ metaKey: true }, true, blank), { kind: 'swallow' })
  check('a copy of blank cells over several rows (line breaks, painted spaces) swallows the key too', blankRows.map(selection => keyAct({ metaKey: true }, true, selection)), blankRows.map(() => ({ kind: 'swallow' })))
  check('a selection is blank only when it holds nothing visible', [selectionIsBlank(''), selectionIsBlank('\r\n \n'), selectionIsBlank('a\n'), selectionIsBlank('  x  ')], [true, true, false, false])
  check('a copy with nothing selected is left to the terminal', keyAct({ ctrlKey: true, shiftKey: true }, false, unselected), passed)
  check('only a keydown acts, and an Option or Alt chord is left alone', [keyAct({ metaKey: true, type: 'keyup' }, true), keyAct({ metaKey: true, altKey: true, key: 'ç' }, true), keyAct({ ctrlKey: true, shiftKey: true, altKey: true, key: 'V', code: 'KeyV' }, false)], [passed, passed, passed])
  let selectionReads = 0
  const counting = (): SelectionReading => { selectionReads++; return picked }
  quickTerminalKey(key({ metaKey: true, key: 'v', code: 'KeyV' }), true, counting); quickTerminalKey(key({ key: 'a', code: 'KeyA' }), true, counting)
  check('the selection is read only for a copy chord', selectionReads, 0)
  check('a right-click copies a selection and otherwise pastes', [quickTerminalRightClick(picked), quickTerminalRightClick(unselected)], [copied, { kind: 'paste', clear: false }])
  check('a right-click on a blank-cell selection clears it and pastes, never copying an empty string', quickTerminalRightClick(blank), { kind: 'paste', clear: true })
  check('a right-click on blank cells over several rows clears them and pastes, never copying blanks', blankRows.map(quickTerminalRightClick), blankRows.map(() => ({ kind: 'paste', clear: true })))
  check('a selection of text across rows still copies whole', quickTerminalRightClick({ text: 'one\n  two', any: true }), { kind: 'copy', text: 'one\n  two' })
  const pressOf = (over: Partial<PressEvent>): PressEvent => ({ button: 2, ctrlKey: false, shiftKey: false, isTrusted: true, defaultPrevented: false, ...over })
  check('a right press and a macOS Ctrl+click are taken before xterm can report them', [quickTerminalTakesPress(pressOf({}), true), quickTerminalTakesPress(pressOf({}), false), quickTerminalTakesPress(pressOf({ button: 0, ctrlKey: true }), true)], [true, true, true])
  check('a plain press, a middle press and an off-macOS Ctrl+click still reach xterm', [quickTerminalTakesPress(pressOf({ button: 0 }), true), quickTerminalTakesPress(pressOf({ button: 1 }), true), quickTerminalTakesPress(pressOf({ button: 0, ctrlKey: true }), false)], [false, false, false])
  check('the Shift-drag clone and the press it was made from are never taken (gotcha 34)', [quickTerminalTakesPress(pressOf({ button: 0, ctrlKey: true, isTrusted: false }), true), quickTerminalTakesPress(pressOf({ button: 0, ctrlKey: true, shiftKey: true, defaultPrevented: true }), true)], [false, false])
  // Whole press → contextmenu → release sequences, as the panel's three capture listeners feed them.
  const run = (isMac: boolean, steps: Array<['down', Partial<PressEvent>] | ['up', number] | ['menu', SelectionReading]>): unknown[] => {
    const presses = new QuickTerminalPresses(isMac)
    return steps.map(([step, arg]) => step === 'down' ? presses.down(pressOf(arg as Partial<PressEvent>)) : step === 'up' ? presses.up({ button: arg as number }) : presses.context(arg as SelectionReading))
  }
  const ctrlClick: Partial<PressEvent> = { button: 0, ctrlKey: true }, leftPress: Partial<PressEvent> = { button: 0 }
  check('a right-click and a macOS Ctrl+click: the press, the menu and the release are all Stoke’s', [run(true, [['down', {}], ['menu', picked], ['up', 2]]), run(true, [['down', ctrlClick], ['menu', unselected], ['up', 0]])], [[true, copied, true], [true, { kind: 'paste', clear: false }, true]])
  check('a release whose press went to xterm is never stopped (gotcha 34)', run(true, [['down', leftPress], ['up', 0], ['down', {}], ['up', 0], ['up', 2]]), [false, false, true, false, true])
  check('a lost release cannot make the next left drag’s release be stopped', run(true, [['down', ctrlClick], ['down', leftPress], ['up', 0]]), [true, false, false])
  // On macOS Chromium sends a contextmenu for a Ctrl+left press even when it was cancelled.
  const shiftCtrlDrag: Array<['down', Partial<PressEvent>]> = [['down', { button: 0, ctrlKey: true, isTrusted: false }], ['down', { button: 0, ctrlKey: true, shiftKey: true, defaultPrevented: true }]]
  check('a macOS Shift+Ctrl-drag’s contextmenu neither pastes nor copies, and its release reaches xterm', run(true, [...shiftCtrlDrag, ['menu', unselected], ['up', 0]]), [false, false, { kind: 'ignore' }, false])
  check('after that drag, the next right-click acts again', run(true, [...shiftCtrlDrag, ['menu', unselected], ['up', 0], ['down', {}], ['menu', unselected]]), [false, false, { kind: 'ignore' }, false, true, { kind: 'paste', clear: false }])
  check('a drag’s release ends its claim, so a later menu-key contextmenu still acts', run(true, [...shiftCtrlDrag, ['up', 0], ['menu', picked]]), [false, false, false, copied])
  check('a Shift+Ctrl press the shim left alone is a secondary click; off macOS no press is a claimed drag', [run(true, [['down', { button: 0, ctrlKey: true, shiftKey: true }], ['menu', picked]]), run(false, [['down', { button: 0, ctrlKey: true, shiftKey: true, defaultPrevented: true }], ['menu', unselected]])], [[true, copied], [false, { kind: 'paste', clear: false }]])
  const hostile = 'echo safe' + '\x1b[201~' + 'touch owned\r' + '\x9b' + 'x\u0007'
  check('a paste cannot close the bracket early or carry other controls', quickTerminalPasteText(hostile), 'echo safe[201~touch owned\rx')
  check('tabs and line breaks survive a paste, and a non-string pastes nothing', [quickTerminalPasteText('a\tb\r\nc\n'), quickTerminalPasteText(undefined)], ['a\tb\r\nc\n', ''])
  check('main writes no empty or non-string copy over the clipboard', [quickTerminalCopyText(''), quickTerminalCopyText(undefined), quickTerminalCopyText(42)], [null, null, null])
  check('main writes no copy of only line breaks or spaces either, and keeps a copy with text whole', [...blankRows.map(selection => quickTerminalCopyText(selection.text)), quickTerminalCopyText('  a\n')], [null, null, null, '  a\n'])
  check('a copy past the old 200,000 cap is written whole', quickTerminalCopyText('x'.repeat(300_000))?.length, 300_000)
  // '\x1b[200~' is 6 units, so the emoji's high surrogate is the last unit a plain cut would keep.
  const longPaste = '\x1b[200~' + 'a'.repeat(QUICK_TERMINAL_WRITE_MAX - 7) + '🔥' + 'b'.repeat(60_000) + '\x1b[201~'
  const longParts = quickTerminalWrites(longPaste)
  const surrogate = (unit: number, low: boolean): boolean => unit >= (low ? 0xdc00 : 0xd800) && unit <= (low ? 0xdfff : 0xdbff)
  check('a long paste goes as writes main accepts, in order, losing nothing', [longParts.length, longParts.every(part => part.length <= QUICK_TERMINAL_WRITE_MAX), longParts.join('') === longPaste], [2, true, true])
  check('no write ends or starts inside a surrogate pair', longParts.every(part => !surrogate(part.charCodeAt(part.length - 1), false) && !surrogate(part.charCodeAt(0), true)), true)
  check('typing stays one write', quickTerminalWrites('ls\r'), ['ls\r'])
  // The wire from real input to the rules above (gotcha 31): a node suite cannot drive the panel.
  const panelSource = await readFile(new URL('../src/renderer/src/components/QuickTerminal.tsx', import.meta.url), 'utf8')
  const mainSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  check('the panel takes the right-click in the capture phase, before xterm selects a word or reports it', [/addEventListener\('contextmenu', context, true\)/.test(panelSource), /addEventListener\('mousedown', secondaryDown, true\)/.test(panelSource), /const secondaryDown = \(event: MouseEvent\): void => \{ if \(presses\.down\(event\)\) event\.stopPropagation\(\) \}/.test(panelSource), /rightClickSelectsWord: false/.test(panelSource)], [true, true, true, true])
  check('the panel stops a release only when QuickTerminalPresses says its press was taken (gotcha 34)', [/const presses = new QuickTerminalPresses\(isMac\)/.test(panelSource), /const secondaryUp = \(event: MouseEvent\): void => \{ if \(presses\.up\(event\)\) event\.stopPropagation\(\) \}/.test(panelSource), /addEventListener\('mouseup', secondaryUp, true\)/.test(panelSource)], [true, true, true])
  check('a contextmenu acts as decided: nothing for a claimed drag, and a blank selection is cleared before the paste', [/const action = presses\.context\(\{ text: term\.getSelection\(\), any: term\.hasSelection\(\) \}\)\n\s*if \(action\.kind === 'ignore'\) return\n/.test(panelSource), /else \{ if \(action\.clear\) term\.clearSelection\(\); paste\(\) \}/.test(panelSource)], [true, true])
  check('the press guard is installed after the Shift-drag shim it must defer to', panelSource.indexOf('installShiftSelection(node') < panelSource.indexOf("addEventListener('mousedown', secondaryDown"), true)
  check('keys, right-clicks and pastes go through the shared rules', [/quickTerminalKey\(event, isMac,/.test(panelSource), /presses\.context\(\{ text: term\.getSelection\(\), any: term\.hasSelection\(\) \}\)/.test(panelSource), /const clean = quickTerminalPasteText\(text\); if \(alive && clean\) term\.paste\(clean\)/.test(panelSource), /term\.paste\(text\)/.test(panelSource)], [true, true, true, false])
  check('the panel splits every input into writes main accepts', /term\.onData\(data => \{ for \(const part of quickTerminalWrites\(data\)\) api\.write\(id, part\) \}\)/.test(panelSource), true)
  // installMotionGuard's own rule is held by verify:phone-ui; this holds the panel's use of it.
  check('pointer motion under any-motion reporting does not clear the selection', [/const removeMotionGuard = installMotionGuard\(term\)/.test(panelSource), /removeSelection\(\); removeMotionGuard\(\);/.test(panelSource), /triggerDataEvent/.test(panelSource)], [true, true, false])
  check('a DOM copy (Ctrl+Insert, a menu) is kept from xterm only for a blank-cell selection', [quickTerminalStopsCopy(blank), quickTerminalStopsCopy(picked), quickTerminalStopsCopy(unselected), ...blankRows.map(quickTerminalStopsCopy)], [true, false, false, true, true, true])
  check('Shift+Insert, middle-click and menu pastes are cleaned before xterm sees them', [/addEventListener\('paste', pasteEvent, true\)/.test(panelSource), /event\.preventDefault\(\); event\.stopPropagation\(\)\n\s*const clean = quickTerminalPasteText\(event\.clipboardData\?\.getData\('text\/plain'\)\)\n\s*if \(clean\) term\.paste\(clean\)/.test(panelSource), /addEventListener\('copy', copyEvent, true\)/.test(panelSource), /quickTerminalStopsCopy\(\{ text: term\.getSelection\(\), any: term\.hasSelection\(\) \}\)\) event\.stopPropagation\(\)/.test(panelSource)], [true, true, true, true])
  const copyHandler = /ipcMain\.on\(CH\.quickTerminalCopy,[^\n]*/.exec(mainSource)?.[0] ?? '', pasteHandler = /ipcMain\.handle\(CH\.quickTerminalPaste,[^\n]*/.exec(mainSource)?.[0] ?? ''
  check('main copies through quickTerminalCopyText and pastes the clipboard uncut', [/quickTerminalCopyText\(text\)/.test(copyHandler), /200_000|\.slice\(/.test(copyHandler + pasteHandler), /return clipboard\.readText\(\)/.test(pasteHandler)], [true, false, true])

  console.log('\nQuick terminal: installed shell catalog')
  check('shell arguments follow the executable instead of the OS', ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\powershell.exe', '/opt/homebrew/bin/pwsh', '/bin/bash'].map(terminalShellArgs), [['/d'], ['-NoLogo'], ['-NoLogo'], ['-l']])
  let finishPath!: (path: string) => void
  const refreshing = new Promise<string>(resolve => { finishPath = resolve })
  check('a slow environment refresh cannot consume the shell startup deadline', await terminalEnvironmentPath(refreshing, 'owned-inherited-path', 10), 'owned-inherited-path')
  finishPath('owned-refreshed-path')
  check('later shell discovery uses the completed environment refresh', await terminalEnvironmentPath(refreshing, 'owned-inherited-path', 10), 'owned-refreshed-path')
  check('a failed refresh still permits an absolute installed shell', await terminalEnvironmentPath(Promise.reject(new Error('owned registry refusal')), 'owned-inherited-path', 10), 'owned-inherited-path')
  const windowsShells = await discoverTerminalShells({
    platform: 'win32', env: { ComSpec: 'c:\\windows\\SYSTEM32\\cmd.exe', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, path: 'C:\\tools;relative',
    usable: async path => new Set(['c:\\windows\\system32\\cmd.exe', 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe', 'c:\\tools\\pwsh.exe', 'c:\\program files\\git\\bin\\bash.exe']).has(path.toLowerCase()), canonical: async path => path
  })
  check('Windows offers installed cmd, both PowerShell variants and Git Bash without duplicating Default', windowsShells.map(shell => [shell.id, shell.args]), [['default', ['/d']], ['powershell', ['-NoLogo']], ['pwsh', ['-NoLogo']], ['git-bash', ['-l']]])
  const customDefault = await discoverTerminalShells({ platform: 'win32', env: { ComSpec: 'C:\\tools\\pwsh.exe', SystemRoot: 'C:\\Windows' }, path: 'C:\\tools', usable: async path => path === 'C:\\tools\\pwsh.exe' || path === 'C:\\Windows\\System32\\cmd.exe', canonical: async path => path })
  check('a PowerShell default uses PowerShell arguments and still offers cmd', customDefault.map(shell => [shell.id, shell.args]), [['default', ['-NoLogo']], ['cmd', ['/d']]])
  const aliases = await discoverTerminalShells({ platform: 'linux', env: { SHELL: '/bin/bash' }, path: '/usr/bin', usable: async path => ['/bin/bash', '/usr/bin/bash', '/bin/sh'].includes(path), canonical: async path => path === '/bin/bash' ? '/usr/bin/bash' : path })
  check('filesystem aliases do not create two entries for the same shell', aliases.map(shell => shell.id), ['default', 'sh'])
  const catalog = await service.shells()
  check('listing installed shells starts no quick shell and exposes no executable arguments', [catalog.length > 0, preparations, service.view().id, catalog.every(shell => !('args' in shell))], [true, 0, null, true])

  console.log('\nQuick terminal: lifecycle guards and a real native shell')
  check('reading does not prepare or start a process', [service.snapshot().state.phase, preparations], ['idle', 0])
  check('disabled open is refused before preparation', await refused(() => service.open('panel', root)), true)
  enabled = true; service.refreshSettings()
  check('enabling still has no process', [service.view().phase, preparations], ['idle', 0])
  const first = service.open('panel', root)
  check('a second open cannot race the first preparation', await refused(() => service.open('popout', root)), true)
  const state = await first; const id = state.id!
  check('the current terminal may open only complete web links', [quickTerminalLink(state, 'panel', id, 'http://localhost:3000/a'), quickTerminalLink(state, 'panel', id, 'file:///etc/passwd'), quickTerminalLink(state, 'panel', id, 'https://example.com/\nnext'), quickTerminalLink(state, 'panel', id, { url: 'https://example.com' })], ['http://localhost:3000/a', null, null, null])
  check('a disabled or obsolete view cannot dispatch links', [quickTerminalLink({ ...state, enabled: false }, 'panel', id, 'https://example.com'), quickTerminalLink(state, 'popout', id, 'https://example.com'), quickTerminalLink(state, 'panel', 'older-shell', 'https://example.com'), quickTerminalLink({ ...state, mode: 'hidden' }, 'panel', id, 'https://example.com')], [null, null, null, null])
  check('the cwd is canonical and Unicode survives', state.cwd, await realpath(root))
  check('it is an ordinary platform shell', state.shell.toLowerCase().includes(process.platform === 'win32' ? 'cmd.exe' : '/'), true)
  service.write('panel', id, process.platform === 'win32' ? 'echo STOKE_QUICK_ONE>verified.txt & type verified.txt\r' : "printf 'STOKE_QUICK_ONE🔥\\n' > verified.txt; cat verified.txt\r")
  check('native shell really executes the command in its folder', await until(async () => { try { return (await readFile(join(root, 'verified.txt'), 'utf8')).includes('STOKE_QUICK_ONE') } catch { return false } }), true)
  check('native shell output reaches the mirror', await until(() => service.snapshot().data.includes('STOKE_QUICK_ONE')), true)

  console.log('\nQuick terminal: real shell switching retains processes, commands and buffers')
  const alternate = catalog.find(shell => shell.id === (process.platform === 'win32' ? 'powershell' : 'bash')) ?? catalog.find(shell => shell.id !== 'default')
  check('a second native shell is installed on this target', !!alternate, true)
  if (alternate) {
    check('arbitrary executable paths cannot be selected', await refused(() => service.selectShell('panel', process.execPath)), true)
    check('a stale view cannot switch shells', await refused(() => service.selectShell('popout', alternate.id)), true)
    const waiter = join(root, 'wait-for-switch.cjs')
    await writeFile(waiter, `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('switch.ready')) { clearInterval(timer); fs.writeFileSync('background.txt', 'STOKE_BACKGROUND_DONE'); process.stdout.write('STOKE_BACKGROUND_DONE\\n'); } }, 20);`)
    const quote = (text: string): string => process.platform === 'win32' ? `"${text}"` : `'${text.replace(/'/g, "'\\''")}'`
    const keepVariable = process.platform === 'win32' ? 'set STOKE_SWAP_VALUE=retained & ' : 'STOKE_SWAP_VALUE=retained; '
    service.write('panel', id, `${keepVariable}${quote(process.execPath)} ${quote(waiter)}\r`)
    const switching = service.selectShell('panel', alternate.id)
    check('simultaneous switches cannot create duplicate shells', await refused(() => service.selectShell('panel', 'default')), true)
    const selected = await switching
    const alternateId = selected.id!
    check('the selected native shell has its own identity and the same folder', [selected.shellId, alternateId !== id, selected.cwd], [alternate.id, true, state.cwd])
    check('both shells stay running', selected.sessions.filter(session => session.phase === 'running').length, 2)
    service.write('panel', id, process.platform === 'win32' ? 'echo WRONG>wrong-shell.txt\r' : 'printf WRONG > wrong-shell.txt\r')
    service.resize('panel', id, 121, 31)
    check('the inactive shell id cannot resize the selected shell', [service.view().cols, service.view().rows], [80, 24])
    check('the inactive shell id cannot dispatch links', quickTerminalLink(selected, 'panel', id, 'https://example.com'), null)
    const readyCommand = process.platform === 'win32' ? "Set-Content -Path switch.ready -Value READY; Write-Output STOKE_OTHER_SHELL\r" : "printf READY > switch.ready; printf 'STOKE_OTHER_SHELL\\n'\r"
    service.write('panel', alternateId, readyCommand)
    check('a command in the original shell completes while another shell is selected', await until(async () => { try { return (await readFile(join(root, 'background.txt'), 'utf8')) === 'STOKE_BACKGROUND_DONE' } catch { return false } }), true)
    check('the selected shell also executes real commands', await until(() => service.snapshot().data.includes('STOKE_OTHER_SHELL')), true)
    check('invalid selection preserves the selected process', [await refused(() => service.selectShell('panel', 'missing')), service.view().id], [true, alternateId])
    const restored = await service.selectShell('panel', 'default')
    check('switching back reuses the original process and retained output', [restored.id, service.snapshot().data.includes('STOKE_QUICK_ONE'), await until(() => service.snapshot().data.includes('STOKE_BACKGROUND_DONE'))], [id, true, true])
    const variableFrames = frames.length
    service.write('panel', id, process.platform === 'win32' ? 'echo VALUE=%STOKE_SWAP_VALUE%\r' : 'printf "VALUE=%s\\n" "$STOKE_SWAP_VALUE"\r')
    check('switching back retains shell variables', await until(() => frames.slice(variableFrames).some(frame => frame.data.includes('VALUE=retained'))), true)
    check('obsolete input did not create a file', await refused(() => access(join(root, 'wrong-shell.txt'))), true)
    check('state revisions remain monotonic across shell switches', states.every((value, index) => !index || value.revision > states[index - 1].revision), true)
  }
  const before = service.snapshot()
  service.move('popout')
  check('handoff keeps the same shell and output', [service.view().id, service.snapshot().sequence >= before.sequence, service.snapshot().data.includes('STOKE_QUICK_ONE')], [id, true, true])
  const marker = join(root, 'wrong-view.txt')
  const command = process.platform === 'win32' ? `echo WRONG > "${marker}"\r` : "printf WRONG > wrong-view.txt\r"
  service.write('panel', id, command)
  await new Promise(resolve => setTimeout(resolve, 40))
  let wrongFile = false
  try { await access(marker); wrongFile = true } catch { /* expected */ }
  check('the old panel cannot execute a command after transfer', wrongFile, false)
  service.resize('panel', id, 111, 33)
  check('the old panel cannot resize the pop-out shell', [service.view().cols, service.view().rows], [80, 24])
  service.resize('popout', id, 91, 27)
  check('the active view owns the grid', [service.view().cols, service.view().rows], [91, 27])
  service.write('popout', 'another-agent-id', command)
  service.move('hidden')
  check('hiding retains the running shell', [service.view().phase, service.view().id], ['running', id])
  service.move('panel')
  const n = frames.length
  service.write('panel', id, process.platform === 'win32' ? 'echo STOKE_QUICK_TWO\r' : "printf 'STOKE_QUICK_TWO\\n'\r")
  check('the same shell resumes accepting input', await until(() => frames.slice(n).some(frame => frame.data.includes('STOKE_QUICK_TWO'))), true)
  check('a running shell cannot be restarted alongside itself', await refused(() => service.restart('panel')), true)
  service.write('panel', id, 'exit\r')
  check('natural exit is retained with its last screen', await until(() => service.view().phase === 'exited'), true)
  check('reopening an ended shell does not secretly spawn', (await service.open('popout')).id, id)
  const next = await service.restart('panel')
  check('explicit new shell has a new identity', next.id !== id, true)
  check('restarting from a pop-out into the panel updates the terminal view', next.mode, 'panel')
  const afterRestart = await service.context('restart-view', root)
  check('a later tab activation retains the restarted panel presentation', afterRestart.mode, 'panel')
  await service.context(null, root)
  enabled = false; service.disable()
  check('disable hides and waits for process exit', [service.view().mode, await until(() => service.view().phase === 'exited')], ['hidden', true])
  check('disabling also closes inactive shell processes', await until(() => service.view().sessions.every(session => session.phase === 'exited')), true)
  enabled = true; service.refreshSettings()
  check('reenabling does not relaunch commands', service.view().phase, 'exited')
  if (process.platform !== 'win32') {
    const held = await service.restart('panel')
    service.write('panel', held.id!, "trap '' HUP; printf READY > hold.ready\r")
    check('the real shell installs its HUP handler before shutdown', await until(async () => { try { return (await readFile(join(root, 'hold.ready'), 'utf8')) === 'READY' } catch { return false } }), true)
    const began = Date.now(); service.end()
    check('shutdown retains ownership of an uncooperative shell', [service.view().phase, await refused(() => service.restart('popout'))], ['stopping', true])
    check('an ignored HUP eventually forces only the owned shell to exit', await until(() => service.view().phase === 'exited'), true)
    check('the grace period is actually observed', Date.now() - began >= 1800, true)
  }

  console.log('\nQuick terminal: snapshot boundary and environment isolation')
  const written: string[] = []; const replay = new QuickTerminalReplay(id, data => written.push(data))
  replay.frame({ id, sequence: 1, data: 'already captured' }); replay.frame({ id, sequence: 3, data: 'after' })
  replay.frame({ id: 'another-shell', sequence: 99, data: 'wrong' })
  replay.snapshot({ state, sequence: 2, data: 'snapshot🔥' })
  replay.frame({ id, sequence: 3, data: 'duplicate' }); replay.frame({ id, sequence: 4, data: 'next' })
  check('queued frames covered by a snapshot never replay twice', written, ['snapshot🔥', 'after', 'next'])
  const env = quickTerminalEnv({ PATH: '/stale', NODE_OPTIONS: 'never', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_CHILD_SESSION: 'yes', TERM_PROGRAM: 'another-wrapper', STOKE_QUICK_FIXTURE: 'retained' }, '/usr/bin:/bin')
  check('agent runtime markers cannot nest shell commands', [env.NODE_OPTIONS, env.ELECTRON_RUN_AS_NODE, env.CLAUDE_CODE_CHILD_SESSION, env.TERM_PROGRAM, env.STOKE_QUICK_FIXTURE], [undefined, undefined, undefined, 'Stoke', 'retained'])
  // A Dock launch gives main no locale; bash's readline then turns bytes >= 0x80 into Meta keys.
  const utf8 = process.platform === 'win32' ? undefined : process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  check('a launch with no locale gets a UTF-8 LANG', quickTerminalEnv({ PATH: '/x' }, '/usr/bin:/bin').LANG, utf8)
  check('an explicit LANG is kept', quickTerminalEnv({ LANG: 'fr_FR.UTF-8' }, '/usr/bin:/bin').LANG, 'fr_FR.UTF-8')
  check('an LC_ALL or LC_CTYPE is left to rule, with no LANG added', [quickTerminalEnv({ LC_ALL: 'de_DE.UTF-8' }, '/usr/bin:/bin').LANG, quickTerminalEnv({ LC_CTYPE: 'UTF-8' }, '/usr/bin:/bin').LANG], [undefined, undefined])

  console.log('\nQuick terminal: independent tab folders, shell state and pinning')
  const folderA = join(root, 'tab-one'), folderB = join(root, 'tab-two')
  await Promise.all([mkdir(folderA), mkdir(folderB)])
  let tabPreparations = 0
  // No locale on purpose, as a Dock launch has none: the root's emoji then reaches bash's
  // readline, which runs it only if quickTerminalEnv supplied a UTF-8 locale.
  const localeFree = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'LANG' && !key.startsWith('LC_')))
  const scoped = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => { tabPreparations++; return quickTerminalEnv({ ...localeFree, HOME: root, ZDOTDIR: root, STOKE_TAB_VALUE: '' }, process.env.PATH || '/usr/bin:/bin') } })
  const reportFixture = join(root, 'tab-shell-report.cjs')
  await writeFile(reportFixture, `const fs = require('node:fs'); fs.writeFileSync(process.argv[2], JSON.stringify({cwd:process.cwd(),value:process.env.STOKE_TAB_VALUE||null})); process.stdout.write('STOKE_CONTEXT_'+process.argv[3]+'\\n');`)
  const shellQuote = (value: string): string => process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`
  const report = (shell: QuickTerminalState, folder: string, label: string, value?: string): string => {
    const path = join(folder, `${label}.json`)
    const powershell = process.platform === 'win32' && /(?:powershell|pwsh)\.exe$/i.test(shell.shell)
    const assign = value === undefined ? '' : powershell ? `$env:STOKE_TAB_VALUE='${value}'; ` : process.platform === 'win32' ? `set "STOKE_TAB_VALUE=${value}"\r` : `export STOKE_TAB_VALUE='${value}'; `
    scoped.write('panel', shell.id!, `${assign}${powershell ? '& ' : ''}${shellQuote(process.execPath)} ${shellQuote(reportFixture)} ${shellQuote(path)} ${label}\r`)
    return path
  }
  const reading = async (path: string): Promise<{ cwd: string; value: string | null } | null> => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null } }
  try {
    await scoped.context('tab-one', folderA); await scoped.context('tab-two', folderB)
    check('changing hidden tabs never prepares or starts a shell', [tabPreparations, scoped.view().id, scoped.view().mode], [0, null, 'hidden'])
    await scoped.context('tab-one', folderA)
    const a = await scoped.open('panel')
    const aReport = report(a, folderA, 'ONE', 'one')
    check('the first tab executes in its own folder with its own shell variable', await until(async () => { const value = await reading(aReport); return value?.cwd === await realpath(folderA) && value.value === 'one' }), true)
    check('the first tab output reaches only its own replay', await until(() => scoped.snapshot().data.includes('STOKE_CONTEXT_ONE')), true)
    const b = await scoped.context('tab-two', folderB)
    check('switching visible tabs selects a different native shell and folder', [b.id !== a.id, b.contextId, b.cwd, b.mode, b.shellId], [true, 'tab-two', await realpath(folderB), 'panel', 'default'])
    const bReport = report(b, folderB, 'TWO')
    check('another tab does not inherit the first shell variable', await until(async () => { const value = await reading(bReport); return value?.cwd === await realpath(folderB) && value.value === null }), true)
    check('another tab has its own output buffer', [await until(() => scoped.snapshot().data.includes('STOKE_CONTEXT_TWO')), scoped.snapshot().data.includes('STOKE_CONTEXT_ONE')], [true, false])
    const stale = join(folderA, 'stale-input.json')
    scoped.write('panel', a.id!, `${shellQuote(process.execPath)} ${shellQuote(reportFixture)} ${shellQuote(stale)} STALE\r`)
    scoped.resize('panel', a.id!, 119, 39)
    check('an inactive tab id cannot resize the current tab', [scoped.view().cols, scoped.view().rows], [80, 24])
    const bBarrier = report(b, folderB, 'BARRIER', 'two')
    check('the active shell still executes after stale input was refused', await until(async () => (await reading(bBarrier))?.value === 'two'), true)
    const back = await scoped.context('tab-one', folderA)
    check('returning to a tab restores its exact process and output', [back.id, scoped.snapshot().data.includes('STOKE_CONTEXT_ONE'), scoped.snapshot().data.includes('STOKE_CONTEXT_TWO')], [a.id, true, false])
    const retained = report(back, folderA, 'RETAINED')
    check('returning to a tab retains its shell variable', await until(async () => (await reading(retained))?.value === 'one'), true)
    check('an inactive tab id cannot send commands to either shell', await refused(() => access(stale)), true)
    const secondShell = (await scoped.shells()).find(shell => shell.id === (process.platform === 'win32' ? 'powershell' : 'bash')) ?? (await scoped.shells()).find(shell => shell.id !== 'default')
    check('tab isolation also has a second installed shell to exercise', !!secondShell, true)
    if (secondShell) {
      const aOther = await scoped.selectShell('panel', secondShell.id)
      const otherReport = report(aOther, folderA, 'OTHER', 'alternate-one')
      check('a tab can select and execute another installed shell independently', await until(async () => (await reading(otherReport))?.value === 'alternate-one', 15_000), true)
      const bAgain = await scoped.context('tab-two', folderB)
      check('another tab retains its own selected shell and native process', [bAgain.shellId, bAgain.id], ['default', b.id])
      const aAgain = await scoped.context('tab-one', folderA)
      check('a tab remembers its alternate shell and buffer', [aAgain.shellId, aAgain.id, await until(() => scoped.snapshot().data.includes('STOKE_CONTEXT_OTHER'))], [secondShell.id, aOther.id, true])
      const pinned = await scoped.pin(true)
      const across = await scoped.context('tab-two', folderB)
      check('pinning keeps the selected shell, folder and buffer across tabs', [pinned.pinned, across.pinned, across.contextId, across.id, across.cwd, scoped.snapshot().data.includes('STOKE_CONTEXT_OTHER')], [true, true, 'tab-one', aOther.id, await realpath(folderA), true])
      const unpinned = await scoped.pin(false)
      check('unpinning restores the current tab process, shell selection and buffer', [unpinned.pinned, unpinned.contextId, unpinned.id, unpinned.shellId, scoped.snapshot().data.includes('STOKE_CONTEXT_TWO'), scoped.snapshot().data.includes('STOKE_CONTEXT_OTHER')], [false, 'tab-two', b.id, 'default', true, false])
    }
    scoped.move('hidden')
    const prepared = tabPreparations
    await scoped.context('tab-one', folderA); await scoped.context('tab-two', folderB)
    check('hidden tab switches preserve shells without spawning more', [tabPreparations, scoped.view().mode], [prepared, 'hidden'])
    check('all context and shell processes remain owned until disposal', ownedPtyExits.count >= (secondShell ? 3 : 2), true)
    scoped.retainContexts(new Set(['tab-two']))
    check('closing an ordinary tab drains all its selected and inactive shells', await until(() => ownedPtyExits.count === 1), true)
    scoped.retainContexts(new Set(['tab-one', 'tab-two']))
    await scoped.context('tab-one', folderA)
    const reopened = await scoped.open('panel')
    check('a retired tab cannot reuse its old native process', reopened.id !== a.id, true)
    await scoped.pin(true); await scoped.context('tab-two', folderB)
    scoped.retainContexts(new Set(['tab-two']))
    check('closing a pinned source tab keeps its shell alive until unpin', [scoped.view().id, scoped.view().pinned, ownedPtyExits.count], [reopened.id, true, 2])
    const afterOrphan = await scoped.pin(false)
    check('unpin restores the live current tab after the pinned source was closed', [afterOrphan.contextId, afterOrphan.id, afterOrphan.pinned, await until(() => ownedPtyExits.count === 1)], ['tab-two', b.id, false, true])
    scoped.retainContexts(new Set(['tab-one', 'tab-two']))
    await scoped.context('tab-one', folderA); await scoped.context('tab-two', folderB)
    check('multiple tab shells remain owned immediately before app disposal', ownedPtyExits.count, 2)
  } finally {
    scoped.dispose()
    check('app disposal drains native shells from every tab and shell selection', await ownedPtyExits.wait(), 0)
  }

  // A real shell, but the paste itself never reaches it: what is checked is
  // what main's write accepts, not how a line editor takes 300,000 characters.
  const delivered: string[] = []
  const recording = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin'), runtime: async () => {
    const [pty, screen] = await Promise.all([import('@lydell/node-pty'), import('../src/main/screenMirror.ts')])
    return { spawn: (...args: Parameters<typeof pty.spawn>) => { const child = pty.spawn(...args); child.write = (data: string | Buffer) => { delivered.push(String(data)) }; return child }, mirror: (cols: number, rows: number) => new screen.ScreenMirror(cols, rows) }
  } })
  try {
    const recorded = await recording.open('panel', root)
    recording.write('panel', recorded.id!, longPaste)
    check('one write past the cap is still refused whole, which is why the panel splits a paste', delivered.length, 0)
    for (const part of quickTerminalWrites(longPaste)) recording.write('panel', recorded.id!, part)
    check('a split paste past the cap reaches the shell whole and in order', [delivered.length, delivered.join('') === longPaste], [2, true])
  } finally { recording.dispose(); check('the paste-recording shell drains', await ownedPtyExits.wait(), 0) }

  let releaseActivation!: () => void
  const activationGate = new Promise<void>(resolve => { releaseActivation = resolve })
  let activationPreparations = 0
  const activationFolders: string[] = []
  const activating = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => { if (++activationPreparations === 1) await activationGate; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') }, runtime: async () => {
    const [pty, screen] = await Promise.all([import('@lydell/node-pty'), import('../src/main/screenMirror.ts')])
    return { spawn: (...args: Parameters<typeof pty.spawn>) => { activationFolders.push(String(args[2].cwd)); return pty.spawn(...args) }, mirror: (cols: number, rows: number) => new screen.ScreenMirror(cols, rows) }
  } })
  try {
    await activating.context('tab-one', folderA)
    const openingTab = activating.open('panel')
    await until(() => activationPreparations === 1)
    const changingTab = activating.context('tab-two', folderB)
    releaseActivation()
    check('changing tabs cancels a pending opening instead of activating it late', await refused(() => openingTab), true)
    await changingTab
    check('the current tab wins after the old preparation completes', [activating.view().contextId, activating.view().cwd === await realpath(folderA), activating.view().sessions.some(session => session.phase === 'starting')], ['tab-two', false, false])
    check('a cancelled tab preparation never creates its native process', activationFolders.includes(await realpath(folderA)), false)
  } finally { releaseActivation(); activating.dispose(); check('cancelled tab activation leaves no native process or transport behind', await ownedPtyExits.wait(), 0) }

  let releaseRapid!: () => void
  const rapidGate = new Promise<void>(resolve => { releaseRapid = resolve })
  let rapidPreparations = 0
  const rapid = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => { if (++rapidPreparations === 1) await rapidGate; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') } })
  try {
    await rapid.context('tab-one', folderA)
    const oldOpening = refused(() => rapid.open('panel'))
    await until(() => rapidPreparations === 1)
    const toB = rapid.context('tab-two', folderB)
    const backToA = rapid.context('tab-one', folderA)
    const transitions = Promise.allSettled([toB, backToA])
    releaseRapid()
    check('rapid tab changes cancel the original pending shell opening', await oldOpening, true)
    check('rapid tab transitions settle without operation-claim races', (await transitions).every(result => result.status === 'fulfilled'), true)
    check('rapid A to B to A activation selects the final tab without reviving a canceled start', [rapid.view().contextId, rapid.view().cwd, rapid.view().phase, rapid.view().mode], ['tab-one', await realpath(folderA), 'running', 'panel'])
  } finally { releaseRapid(); rapid.dispose(); check('rapid activation drains every owned native shell', await ownedPtyExits.wait(), 0) }

  let releaseExplicit!: () => void
  const explicitGate = new Promise<void>(resolve => { releaseExplicit = resolve })
  let explicitPreparations = 0
  const explicit = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => { if (++explicitPreparations === 2) await explicitGate; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') } })
  try {
    await explicit.context('tab-two', folderB)
    const current = await explicit.open('panel')
    const oldRequest = refused(() => explicit.open('popout', folderA, 'tab-one'))
    await until(() => explicitPreparations === 2)
    await explicit.context('tab-two', folderB)
    releaseExplicit()
    check('an explicit open superseded during tab preparation is refused', await oldRequest, true)
    check('a superseded open cannot apply its folder or pop-out mode to another tab', [explicit.view().id, explicit.view().contextId, explicit.view().cwd, explicit.view().mode], [current.id, 'tab-two', await realpath(folderB), 'panel'])
  } finally { releaseExplicit(); explicit.dispose(); check('superseded explicit opens drain their owned transports', await ownedPtyExits.wait(), 0) }

  const recoveringFolder = join(root, 'not-yet-created')
  const recovering = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') })
  try {
    await recovering.context('unavailable-folder', recoveringFolder)
    check('opening an unavailable tab folder is refused', await refused(() => recovering.open('panel')), true)
    check('retrying an unavailable idle tab never falls back to a home shell', [await refused(() => recovering.restart('panel')), recovering.view().id, recovering.view().phase], [true, null, 'idle'])
    await mkdir(recoveringFolder)
    const recovered = await recovering.restart('panel')
    check('an idle tab retry uses its own folder after it becomes available', [recovered.contextId, recovered.cwd, recovered.phase, recovered.mode], ['unavailable-folder', await realpath(recoveringFolder), 'running', 'panel'])
  } finally { recovering.dispose(); check('folder recovery drains its native shell', await ownedPtyExits.wait(), 0) }

  const orphaned = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') })
  try {
    await orphaned.context('tab-one', folderA)
    const pinnedSource = await orphaned.open('panel')
    await orphaned.pin(true); await orphaned.context('tab-two', join(root, 'unavailable-unpin-target'))
    orphaned.retainContexts(new Set(['tab-two']))
    check('a closed pinned source remains owned until the unpin attempt', [orphaned.view().id, ownedPtyExits.count], [pinnedSource.id, 1])
    check('unpinning into an unavailable tab folder reports the failure', await refused(() => orphaned.pin(false)), true)
    check('failed unpin still retires the closed source native shell', await ownedPtyExits.wait(), 0)
    check('failed follow does not restore a closed pinned context', [orphaned.view().contextId, orphaned.view().pinned], ['tab-two', false])
  } finally { orphaned.dispose(); check('failed unpin leaves no native shell transport', await ownedPtyExits.wait(), 0) }

  console.log('\nQuick terminal: cancellation and bad folders')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const pending = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, environment: async () => { calls++; await gate; return env } })
  const opening = pending.open('panel', root)
  pending.disable(); pending.refreshSettings()
  check('a canceled preparation keeps its claim until it settles', await refused(() => pending.open('panel', root)), true)
  release(); check('a disable while preparing never starts a late shell', await refused(() => opening), true)
  check('canceled state is idle', [pending.view().phase, calls], ['idle', 1]); pending.dispose()
  check('a disposed service refuses a later open', await refused(() => pending.open('panel', root)), true)
  check('a disposed service refuses a restart', await refused(() => pending.restart('panel')), true)
  let releaseCatalog!: () => void
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve })
  let latePreparations = 0
  const slowCatalog = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, shells: async () => { await catalogGate; return [{ id: 'default', label: 'Default', path: process.execPath, args: [] }] }, environment: async () => { latePreparations++; return env } })
  slowCatalog.move('panel')
  const selecting = slowCatalog.selectShell('panel', 'default')
  enabled = false; slowCatalog.disable(); enabled = true; slowCatalog.refreshSettings()
  check('a disable while discovering shells retains its operation claim', await refused(() => slowCatalog.selectShell('panel', 'default')), true)
  releaseCatalog()
  check('reenabling cannot resurrect a canceled shell selection', [await refused(() => selecting), latePreparations, slowCatalog.view().id, slowCatalog.view().mode], [true, 0, null, 'hidden'])
  slowCatalog.dispose()
  const resolved = await discoverTerminalShells()
  let releaseSwitch!: () => void
  const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve })
  let switchPreparations = 0
  const guarded = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {}, shells: async () => [...resolved, { id: 'removed', label: 'Removed', path: join(root, 'missing-shell'), args: [] }], environment: async () => { if (++switchPreparations === 3) await switchGate; return quickTerminalEnv({ ...process.env, HOME: root, ZDOTDIR: root }, process.env.PATH || '/usr/bin:/bin') } })
  try {
    const original = await guarded.open('panel', root)
    check('a failed shell launch preserves the active process and view', [await refused(() => guarded.selectShell('panel', 'removed')), guarded.view().id, guarded.view().phase, guarded.view().sessions.length], [true, original.id, 'running', 1])
    const other = resolved.find(shell => shell.id !== 'default')
    if (other) {
      const delayedSwitch = guarded.selectShell('panel', other.id)
      await until(() => switchPreparations === 3)
      enabled = false; guarded.disable(); enabled = true; guarded.refreshSettings()
      releaseSwitch()
      check('disabling and reenabling during shell preparation never launches the pending selection', [await refused(() => delayedSwitch), guarded.view().shellId, guarded.view().mode, guarded.view().sessions.length], [true, 'default', 'hidden', 1])
      await until(() => guarded.view().phase === 'exited')
      await guarded.restart('panel'); await guarded.selectShell('panel', other.id)
      check('two saved shell processes remain owned before app disposal', guarded.view().sessions.filter(session => session.phase === 'running').length, 2)
      guarded.dispose()
      check('app disposal drains both the visible and inactive shells', await until(() => guarded.view().sessions.every(session => session.phase === 'exited')), true)
    }
  } finally { releaseSwitch?.(); guarded.dispose() }
  const file = join(root, 'file'); await writeFile(file, 'bystander')
  const bad = new QuickTerminal({ enabled: () => enabled, onState: () => {}, onData: () => {} })
  check('files are not working folders', await refused(() => bad.open('panel', file)), true)
  check('relative folders are refused', await refused(() => bad.open('panel', 'relative')), true)
  if (process.platform !== 'win32') {
    const alias = `${root}-alias`; await symlink(root, alias)
    try { await bad.open('panel', alias); check('symlink aliases use one canonical folder', bad.view().cwd, await realpath(root)); bad.end(); await until(() => bad.view().phase === 'exited') }
    finally { await rm(alias, { force: true }) }
  }
  bad.dispose()
} finally { service.dispose(); check('all owned native shell callbacks drain before shutdown', await ownedPtyExits.wait(), 0); await rm(root, { recursive: true, force: true }) }
// A success also requires the real native transports to let Node exit. An
// unref'd watchdog cannot prolong a healthy run, but makes a leaked worker
// fail instead of leaving the Windows portability job stuck for 45 minutes.
setTimeout(() => {
  console.error('  FAIL native terminal transports remain open after shell exit and cleanup')
  process.exit(1)
}, 5000).unref()
process.once('beforeExit', () => {
  console.log(`\n${failures ? `${failures} failures` : 'All quick terminal checks passed, including native transport cleanup'}`)
  process.exitCode = failures ? 1 : 0
})
