/*
 * Nothing floats behind the docked browser. Gotcha 14.
 *
 * The browser is a native WebContentsView composited above the whole renderer,
 * so a popover, menu or dialog drawn where it sits is invisible — no z-index
 * can lift DOM over it. The fix is to hide the view while a layer overlaps it:
 * App's `overlayOpen` for the full-screen overlays, `useFloatingLayer` for
 * everything smaller. The usage panel shipped without either and sat behind
 * the browser, as the phone popover had before 1c93b7a; each was fixed alone.
 *
 * This suite is the net under the next one. It checks the geometry rule
 * (`coversBrowser`), then reads every component: a file that draws a floating
 * layer must register it with `useFloatingLayer`, or be one of the overlays
 * App's `overlayOpen` already hides the browser for — and that list is checked
 * against App's own expression, so the two cannot drift apart silently.
 *
 *   node scripts/verify-layers.mts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { coversBrowser, type Rect } from '../src/shared/floating.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })

console.log('the geometry rule')
{
  // A 940px window with the browser docked on the right, below a 44px title bar.
  const hole = rect(600, 80, 940, 700)
  check('nothing open covers nothing', coversBrowser([], hole), false)
  check('the usage panel, dropped from the title bar over the browser, covers it', coversBrowser([rect(640, 44, 900, 300)], hole), true)
  check('a terminal menu on the far side of the window does not', coversBrowser([rect(120, 200, 300, 400)], hole), false)
  check('a menu whose right edge only touches the browser does not', coversBrowser([rect(420, 200, 600, 400)], hole), false)
  check('one pixel over it does', coversBrowser([rect(421, 200, 601, 400)], hole), true)
  check('a title-bar popover that ends above the browser does not', coversBrowser([rect(640, 44, 900, 80)], hole), false)
  check('one covering layer among several is enough', coversBrowser([rect(0, 0, 10, 10), rect(700, 100, 800, 200)], hole), true)
  check('a layer with no area (not laid out yet) covers nothing', coversBrowser([rect(700, 100, 700, 200)], hole), false)
  check('a browser with no area is covered by nothing', coversBrowser([rect(0, 0, 940, 700)], rect(600, 80, 600, 700)), false)
  check(
    'no browser placeholder in the page errs towards hiding: a layer behind the browser is the failure',
    coversBrowser([rect(0, 0, 10, 10)], null),
    true
  )
  check('but with nothing open, no placeholder still hides nothing', coversBrowser([], null), false)
}

const root = new URL('../', import.meta.url).pathname
const rendererDir = join(root, 'src/renderer/src')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(path))
    else if (entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

/*
 * What marks a floating layer in markup. Class tokens are the stylesheet's
 * positioned boxes (`position: fixed`, or `absolute` outside their parent's
 * flow); roles catch a layer that picks a new class name.
 */
const FLOATING_CLASSES = new Set([
  'popover',
  'context-menu',
  'project-meta-pop',
  'campfire',
  'confirm-modal',
  'palette',
  'settings-modal',
  'agent-picker'
])
const FLOATING_ROLE = /\brole="(dialog|alertdialog|menu)"/

function floatingMarkers(src: string): string[] {
  const found = new Set<string>()
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const token of (m[1] ?? m[2] ?? '').split(/\s+/)) {
      const bare = token.replace(/\$\{.*$/, '')
      if (FLOATING_CLASSES.has(bare)) found.add(`.${bare}`)
    }
  }
  const role = src.match(FLOATING_ROLE)
  if (role) found.add(`role=${role[1]}`)
  return [...found]
}

/*
 * The overlays App hides the browser for through `overlayOpen`, each with the
 * state that opens it. The expression in App.tsx is read below, so removing a
 * term there without registering the layer fails here.
 */
const OVERLAY_COVERED: Record<string, string> = {
  'components/CommandPalette.tsx': 'paletteOpen',
  'components/SettingsSheet.tsx': 'settingsOpen',
  'components/AgentPicker.tsx': 'agentPickerOpen',
  'components/BusyDialog.tsx': 'busyPrompt'
}

const app = readFileSync(join(rendererDir, 'App.tsx'), 'utf8')

console.log('\nApp hides the browser for every kind of layer')
{
  const overlay = app.match(/const overlayOpen = ([^\n]+)/)?.[1] ?? ''
  for (const [file, state] of Object.entries(OVERLAY_COVERED)) {
    check(`overlayOpen still includes ${state} (${file})`, new RegExp(`\\b${state}\\b`).test(overlay), true)
  }
  check('App reads the floating-layer store', /useBrowserCovered\(\)/.test(app), true)
  const show = app.match(/if \(browserOpen && ([^)]+)\)/)?.[1] ?? ''
  check('and the browser shows only while no overlay is open', /!overlayOpen\b/.test(show), true)
  check('and no registered layer lies over it', /!layerOverBrowser\b/.test(show), true)
  const panel = readFileSync(join(rendererDir, 'components/BrowserPanel.tsx'), 'utf8')
  check('the placeholder the store measures is still .browser-hole', /className="browser-hole"/.test(panel), true)
  const store = readFileSync(join(rendererDir, 'lib/floatingLayers.ts'), 'utf8')
  check("and the store measures that class, not a stale one", /querySelector\('\.browser-hole'\)/.test(store), true)
}

console.log('\nevery component that floats something registers it')
{
  const files = tsxFiles(rendererDir).sort()
  let seen = 0
  for (const path of files) {
    const rel = relative(rendererDir, path)
    const src = readFileSync(path, 'utf8')
    const markers = floatingMarkers(src)
    if (markers.length === 0) continue
    seen++
    const registers = /\buseFloatingLayer\(/.test(src)
    const covered = rel in OVERLAY_COVERED
    check(`${rel} (${markers.join(', ')}) ${covered ? 'is an overlayOpen overlay' : 'calls useFloatingLayer'}`, registers || covered, true)
  }
  // The scan must have found the layers this suite was written against, or a
  // renamed class has quietly turned it into a check of nothing.
  check('the scan still finds the known layers (at least ten files)', seen >= 10, true)
  for (const known of ['UsageMeter.tsx', 'PhonePopover.tsx', 'ContextMenu.tsx', 'Launcher.tsx', 'FolderSwitcher.tsx']) {
    const src = readFileSync(join(rendererDir, 'components', known), 'utf8')
    check(`${known} is still recognised as a floating layer`, floatingMarkers(src).length > 0, true)
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
