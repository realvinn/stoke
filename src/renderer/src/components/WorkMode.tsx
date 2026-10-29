/**
 * Work mode: the whole window becomes a pretend IDE, two editors side by side
 * typing the real code of the project in front, a few characters per key.
 * Pointer movement aims the caret and adds whole lines. Esc twice leaves.
 *
 * An overlay, never a tab kind (design §1): App renders it as a sibling of the
 * shell's three rows and counts it in `overlayOpen`, so the shell is `inert`
 * (gotcha 88), the docked browser's native view is hidden (gotcha 14), and the
 * shell keeps its exact size underneath (no pty is resized).
 *
 * Keys: ONE capture listener on `window` stops every key before anything else
 * in the page acts on it. Only a few OS chords pass through untouched
 * (`workModeKey`). Main's `before-input-event` tab chords are switched off for
 * this window while it is up (`workMode.active`), and App's own listeners
 * return early. After the leave, keys are swallowed until the keyboard has
 * been quiet for `WM_TAIL_QUIET_MS`, so the rest of a burst never lands in the
 * terminal that gets focus back.
 *
 * File text is untrusted: rendered as React text only, never as HTML.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import '../styles/workMode.css'
import {
  EXIT_START,
  POINTER_START,
  WM_HINT_AGAIN_MS,
  WM_HINT_MS,
  WM_OPTIONS_DEFAULT,
  WM_PANEL_LINES_MAX,
  WM_TAIL_QUIET_MS,
  exitStep,
  isTestPath,
  panelBurst,
  panelLineKind,
  panelPrompt,
  panelTestPrompt,
  panelTime,
  pointerBudget,
  seededRandom,
  tailDone,
  workModeKey,
  workModeMenuKey,
  type ExitState,
  type PanelKind,
  type PointerState,
  type WorkModeOptions,
  type WorkModeSource
} from '@shared/workMode'
import { activeTab, newSession, reduceWorkMode, rowOfRef, type Session, type View, type WorkModeAction } from '@shared/workModeDoc'
import { sampleSource } from '../lib/workModeSample'
import { WorkModeEditor, type EditorTab } from './WorkModeEditor'
import { WorkModeExplorer } from './WorkModeExplorer'
import { ActivityBar, BottomPanel, Hint, StatusBar, TitleStrip, type PanelLine, type PanelTerm, type StatusInfo } from './WorkModeChrome'
import { WorkModeMenu } from './WorkModeMenu'

export interface WorkModeProps {
  /** The folder of the tab it was opened from, chosen at the press; null types the sample. */
  cwd: string | null
  platform: string
  fullScreen: boolean
  /** The plugin was turned off (from any window): leave, through the tail. */
  stop?: boolean
  onDone: () => void
}

type Phase = 'loading' | 'open' | 'leaving'
type RootAction = WorkModeAction | { kind: 'init'; session: Session }

function rootReducer(s: Session | null, a: RootAction): Session | null {
  if (a.kind === 'init') return a.session
  return s ? reduceWorkMode(s, a) : s
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = (): void => setReduced(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function WorkMode({ cwd, platform, fullScreen, stop = false, onDone }: WorkModeProps): React.JSX.Element | null {
  const isMac = platform === 'darwin'
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const phaseRef = useRef<Phase>('loading')
  const [source, setSource] = useState<WorkModeSource | null>(null)
  const [sample, setSample] = useState(false)
  const [options, setOptions] = useState<WorkModeOptions>(WM_OPTIONS_DEFAULT)
  const [automatic, setAutomatic] = useState(true)
  const [session, dispatch] = useReducer(rootReducer, null)
  const [hint, setHint] = useState<{ text: string; key: number } | null>({ text: 'Work mode · press Esc twice to leave', key: 0 })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menu !== null
  /** The panel's terminals: the dev server or watcher, and `npm test` when the toolchain has one (`hasTestTerminal`). */
  const [panel, setPanel] = useState<{ dev: PanelLine[]; test: PanelLine[] | null }>({ dev: [], test: null })
  const [aimTicks, setAimTicks] = useState<[number, number]>([0, 0])
  const reducedMotion = useReducedMotion()
  const seed = useMemo(() => Math.floor(Math.random() * 0x7fffffff), [])
  const rng = useMemo(() => seededRandom(seed ^ 0x5bd1e995), [seed])
  const lastTyped = useRef(0)
  const lastManualTyped = useRef(0)
  const lineId = useRef(0)
  const sourceRef = useRef<WorkModeSource | null>(null)
  sourceRef.current = source
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  /** The last time the panel printed: each burst is stamped with the wall clock, never before this (`panelTime`). */
  const panelAt = useRef(-Infinity)

  /* ------------------------------------------------- open and leave */

  // Main stops taking tab and window chords for this window while it is up (design §4.3).
  useEffect(() => {
    window.stoke.workMode.active(true)
    return () => window.stoke.workMode.active(false)
  }, [])

  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const toLines = useCallback((texts: readonly string[]): PanelLine[] => texts.map((text) => ({ id: ++lineId.current, text, kind: panelLineKind(text) })), [])

  /**
   * One burst into the panel, stamped with the wall clock (in order, `panelTime`).
   * The dev terminal's lines are appended; the test terminal's screen is
   * replaced, as vitest clears it for each run. Test output never goes into
   * the dev server's terminal (prove Finding 4).
   */
  const printPanel = useCallback(
    (src: WorkModeSource, kind: PanelKind, changed: string | null = null) => {
      const project = src.project ?? { name: 'workspace', branch: 'main', toolchain: 'vite' as const }
      const at = (panelAt.current = panelTime(panelAt.current, Date.now()))
      const out = panelBurst({ tool: project.toolchain, name: project.name, files: src.files.map((f) => f.path), tests: src.tree.filter(isTestPath) }, rng, kind, at, changed)
      setPanel((cur) => {
        if (kind === 'start') {
          const prompt: PanelLine = { id: ++lineId.current, text: panelPrompt(project.name, project.branch, project.toolchain), kind: 'prompt' }
          const test: PanelLine[] | null = out.test ? [{ id: ++lineId.current, text: panelTestPrompt(project.name, project.branch), kind: 'prompt' }, ...toLines(out.test)] : null
          return { dev: [prompt, ...toLines(out.dev)], test }
        }
        return {
          dev: out.dev.length ? [...cur.dev, ...toLines(out.dev)].slice(-WM_PANEL_LINES_MAX) : cur.dev,
          test: out.test && cur.test ? toLines(out.test) : cur.test
        }
      })
    },
    [rng, toLines]
  )

  const begin = useCallback(
    (src: WorkModeSource, fromSample: boolean) => {
      setSource(src)
      setSample(fromSample)
      setOptions(src.options)
      dispatch({ kind: 'init', session: newSession(src.files, src.picks, src.options.charsPerKey, seed) })
      if (phaseRef.current === 'loading') {
        phaseRef.current = 'open'
        setPhase('open')
      }
      printPanel(src, 'start')
    },
    [seed, printPanel]
  )

  useEffect(() => {
    let live = true
    window.stoke.workMode
      .source(cwd)
      .then((src) => {
        if (!live) return
        if (src.files.length) begin(src, false)
        else begin(sampleSource(src.options, src.picks), true)
      })
      .catch(() => {
        if (live) begin(sampleSource(WM_OPTIONS_DEFAULT), true)
      })
    return () => {
      live = false
    }
  }, [])

  const tail = useRef<{ last: number; timer: number | undefined }>({ last: 0, timer: undefined })
  const startLeaving = useCallback(() => {
    if (phaseRef.current === 'leaving') return
    phaseRef.current = 'leaving'
    setPhase('leaving')
    setMenu(null)
    tail.current.last = performance.now()
    const check = (): void => {
      const now = performance.now()
      if (tailDone(tail.current.last, now)) onDoneRef.current()
      else tail.current.timer = window.setTimeout(check, Math.max(10, WM_TAIL_QUIET_MS - (now - tail.current.last)))
    }
    tail.current.timer = window.setTimeout(check, WM_TAIL_QUIET_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(tail.current.timer), [])

  useEffect(() => {
    if (stop) startLeaving()
  }, [stop, startLeaving])

  // The hint: shown at open, and "again" after one Escape; gone by unmount, never a keyframe resting at 0.
  useEffect(() => {
    if (!hint) return
    const t = window.setTimeout(() => setHint(null), hint.text.startsWith('Press Esc again') ? WM_HINT_AGAIN_MS : WM_HINT_MS)
    return () => window.clearTimeout(t)
  }, [hint])

  /* ----------------------------------------------------------- keys */

  const exitRef = useRef<ExitState>(EXIT_START)
  const save = useCallback(() => {
    dispatch({ kind: 'save' })
    const src = sourceRef.current
    const s = sessionRef.current
    // The panel reports the file that was saved: the active editor's.
    const saved = s ? (activeTab(s, s.active)?.file.path ?? null) : null
    if (src && options.panel) printPanel(src, 'save', saved)
  }, [printPanel, options.panel])
  const saveRef = useRef(save)
  saveRef.current = save

  // Simulate short bursts of typing, with pauses and occasional saves and
  // editor changes. This drives only the in-memory pretend documents.
  useEffect(() => {
    if (phase !== 'open' || !automatic || menu !== null) return
    let timer = 0
    let strokes = 0
    const tick = (): void => {
      if (phaseRef.current !== 'open') return
      if (performance.now() - lastManualTyped.current >= 1200) {
        if (strokes > 0 && strokes % 45 === 0) saveRef.current()
        if (strokes > 0 && strokes % 85 === 0 && sessionRef.current) {
          dispatch({ kind: 'focus', group: sessionRef.current.active === 0 ? 1 : 0 })
        }
        lastTyped.current = performance.now()
        dispatch({ kind: 'type' })
        strokes++
      }
      const pause = strokes > 0 && strokes % 23 === 0
      timer = window.setTimeout(tick, pause ? 1200 + rng() * 1800 : 110 + rng() * 190)
    }
    timer = window.setTimeout(tick, 1000)
    return () => window.clearTimeout(timer)
  }, [phase, automatic, menu, rng])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Always, first: nothing else in the page acts on a key while Work mode is up.
      e.stopPropagation()
      if (phaseRef.current === 'leaving') {
        e.preventDefault()
        tail.current.last = performance.now()
        return
      }
      const menuEl = menuRef.current
      if (menuOpenRef.current && menuEl && e.target instanceof Node && menuEl.contains(e.target)) {
        // The menu's own controls work natively; Escape closes it and does not count towards leaving.
        if (e.key === 'Escape') {
          e.preventDefault()
          setMenu(null)
          rootRef.current?.focus({ preventScroll: true })
          return
        }
        // Any other chord stops here: left alone it reaches the default menu, whose Cmd+W closes the window (`workModeMenuKey`, gotcha 178).
        if (workModeMenuKey(e, isMac) === 'block') e.preventDefault()
        return
      }
      const kind = workModeKey(e, isMac)
      // An OS chord: no preventDefault, so the default menu and the OS still act.
      if (kind === 'pass') return
      e.preventDefault()
      const ex = exitStep(exitRef.current, { key: e.key, repeat: e.repeat, at: e.timeStamp, kind })
      exitRef.current = ex.state
      if (ex.leave) return startLeaving()
      if (ex.armed) setHint({ text: 'Press Esc again to leave', key: e.timeStamp })
      if (kind === 'exit' || kind === 'ignore') return
      if (menuOpenRef.current) setMenu(null)
      if (kind === 'save') return saveRef.current()
      lastTyped.current = performance.now()
      lastManualTyped.current = lastTyped.current
      dispatch({ kind: 'type' })
    }
    const swallow = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (phaseRef.current === 'leaving') e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', swallow, true)
    window.addEventListener('keypress', swallow, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', swallow, true)
      window.removeEventListener('keypress', swallow, true)
    }
  }, [isMac, startLeaving])

  /* -------------------------------------------------------- pointer */

  const pointer = useRef<PointerState>(POINTER_START)
  const pending = useRef<{ aim: { group: 0 | 1; row: number; view: View; tops: Int32Array | null } | null; fill: 0 | 1 | null; frame: number }>({ aim: null, fill: null, frame: 0 })
  const flush = useCallback(() => {
    const p = pending.current
    p.frame = 0
    if (p.aim) {
      const { group, row, view, tops } = p.aim
      // Rows are visual (soft wrap); `tops` says which line each one belongs to.
      dispatch({ kind: 'aim', group, row, view, tops: tops ?? undefined })
      setAimTicks((cur) => (group === 0 ? [cur[0] + 1, cur[1]] : [cur[0], cur[1] + 1]))
    }
    if (p.fill !== null) dispatch({ kind: 'fill', group: p.fill })
    p.aim = null
    p.fill = null
  }, [])
  const onPointer = useCallback(
    (group: 0 | 1, row: number, view: View, tops: Int32Array | null, x: number, y: number, at: number) => {
      if (phaseRef.current !== 'open' || menuOpenRef.current) return
      lastManualTyped.current = performance.now()
      const b = pointerBudget(pointer.current, { x, y, at })
      pointer.current = b.state
      const p = pending.current
      p.aim = { group, row, view, tops }
      if (b.fill) p.fill = group
      // One dispatch per animation frame, whatever the pointer's rate.
      if (!p.frame) p.frame = requestAnimationFrame(flush)
    },
    [flush]
  )
  useEffect(() => () => cancelAnimationFrame(pending.current.frame), [])
  const onPress = useCallback((group: 0 | 1, row: number, view: View, tops: Int32Array | null) => {
    if (phaseRef.current !== 'open') return
    lastManualTyped.current = performance.now()
    if (menuOpenRef.current) {
      setMenu(null)
      return
    }
    dispatch({ kind: 'aim', group, row, view, tops: tops ?? undefined })
    dispatch({ kind: 'fill', group })
    setAimTicks((cur) => (group === 0 ? [cur[0] + 1, cur[1]] : [cur[0], cur[1] + 1]))
  }, [])
  const onEnter = useCallback((group: 0 | 1) => dispatch({ kind: 'focus', group }), [])

  /* ---------------------------------------------- the build panel */

  useEffect(() => {
    if (phase !== 'open' || !options.panel) return
    let timer = 0
    const tick = (): void => {
      const src = sourceRef.current
      if (src && performance.now() - lastTyped.current < 5000) printPanel(src, 'tick')
      timer = window.setTimeout(tick, 6000 + rng() * 8000)
    }
    timer = window.setTimeout(tick, 6000 + rng() * 8000)
    return () => window.clearTimeout(timer)
  }, [phase, options.panel, rng, printPanel])

  /* ------------------------------------------------- menu changes */

  const applyPicks = useCallback(
    async (picks: string[]) => {
      if (!picks.length) return
      const scan = await window.stoke.workMode.pick(cwd, picks).catch(() => null)
      if (sample || !scan) {
        const src = sampleSource(options, scan?.picks.length ? scan.picks : picks)
        setSource(src)
        dispatch({ kind: 'requeue', files: src.files, picks: src.picks })
        return
      }
      const src = await window.stoke.workMode.source(cwd).catch(() => null)
      if (!src || !src.files.length) return
      setSource(src)
      dispatch({ kind: 'requeue', files: src.files, picks: src.picks })
    },
    [cwd, sample, options]
  )
  const applyOptions = useCallback(async (patch: Partial<WorkModeOptions>) => {
    setOptions((cur) => ({ ...cur, ...patch }))
    if (patch.charsPerKey !== undefined) dispatch({ kind: 'chars', n: patch.charsPerKey })
    const saved = await window.stoke.workMode.options(patch).catch(() => null)
    if (saved) setOptions(saved)
  }, [])

  const openMenu = useCallback((x: number, y: number) => setMenu({ x, y }), [])
  useEffect(() => {
    if (!menu) rootRef.current?.focus({ preventScroll: true })
  }, [menu])

  /* ---------------------------------------------- what is on screen */

  const project = source?.project ?? null
  const projectName = project?.name ?? 'workspace'
  const active = session ? activeTab(session, session.active) : null
  const touched = useMemo(() => {
    const out = new Set<string>()
    if (!session) return out
    for (const g of session.groups) for (const t of g.tabs) if (t.doc.touched) out.add(session.files[t.file].path)
    return out
  }, [session])
  const loaded = useMemo(() => new Map((session?.files ?? []).map((f, i) => [f.path, i] as const)), [session?.files])
  const openPaths = useMemo(() => (session ? session.groups.flatMap((g) => g.tabs.map((t) => session.files[t.file].path)) : []), [session])

  const panelTerms = useMemo<PanelTerm[]>(
    () => (panel.test ? [{ key: 'dev', lines: panel.dev }, { key: 'test', lines: panel.test }] : [{ key: 'dev', lines: panel.dev }]),
    [panel]
  )

  const titleText = active ? `${baseName(active.file.path)} — ${projectName}` : projectName
  // The window's title while it is up (the taskbar and the Window menu show it); the old one comes back after.
  useEffect(() => {
    const before = document.title
    return () => {
      document.title = before
    }
  }, [])
  useEffect(() => {
    if (phase !== 'leaving') document.title = titleText
  }, [titleText, phase])

  const status: StatusInfo | null = active
    ? {
        branch: `${project?.branch ?? 'main'}${touched.size ? '*' : ''}`,
        line: rowOfRef(active.tab.doc, active.tab.doc.caret) + 1,
        col: Math.max(0, active.tab.doc.typed[active.tab.doc.caret]) + 1,
        indent: active.file.indentInfo.tabs ? `Tab Size: ${active.file.indentInfo.size}` : `Spaces: ${active.file.indentInfo.size}`,
        eol: active.file.eol,
        language: active.file.language
      }
    : null

  const tabsOf = (g: 0 | 1): EditorTab[] => {
    if (!session) return []
    const tabs = session.groups[g].tabs
    const names = tabs.map((t) => baseName(session.files[t.file].path))
    return tabs.map((t, i) => {
      const path = session.files[t.file].path
      const dup = names.filter((n) => n === names[i]).length > 1
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
      return { key: `${t.file}`, name: names[i], dir: dup ? dir : null, ext: session.files[t.file].ext, dirty: t.doc.dirty }
    })
  }

  // Leaving: draw nothing, keep the listeners (the tail), until the keyboard is quiet.
  if (phase === 'leaving') return null

  return (
    <div
      ref={rootRef}
      className="wm"
      role="dialog"
      aria-modal="true"
      aria-label="Work mode. Press Escape twice to leave."
      tabIndex={-1}
      onContextMenu={(e) => {
        e.preventDefault()
        if (menuRef.current?.contains(e.target as Node)) return
        openMenu(e.clientX, e.clientY)
      }}
      onPointerDown={(e) => {
        if (menu && !menuRef.current?.contains(e.target as Node) && e.button === 0) setMenu(null)
      }}
    >
      <TitleStrip platform={platform} fullScreen={fullScreen} title={titleText} project={projectName} onMenu={openMenu} />
      <ActivityBar changed={touched.size} onMenu={openMenu} />
      <WorkModeExplorer
        project={projectName}
        tree={source?.tree ?? []}
        loaded={loaded}
        touched={touched}
        open={openPaths}
        activePath={active ? active.file.path : null}
        onOpen={(file) => session && dispatch({ kind: 'open', group: session.active, file })}
      />
      <div className="wm-editors">
        {([0, 1] as const).map((g) => {
          const at = session ? activeTab(session, g) : null
          return (
            <WorkModeEditor
              key={g}
              group={g}
              focused={session?.active === g}
              tabs={tabsOf(g)}
              activeTab={session?.groups[g].active ?? 0}
              file={at?.file ?? null}
              doc={at?.tab.doc ?? null}
              aimTick={aimTicks[g]}
              reducedMotion={reducedMotion}
              onTab={(index) => dispatch({ kind: 'tab', group: g, index })}
              onClose={(index) => dispatch({ kind: 'close', group: g, index })}
              onPointer={onPointer}
              onPress={onPress}
              onEnter={onEnter}
            />
          )
        })}
      </div>
      {options.panel && <BottomPanel terms={panelTerms} />}
      <StatusBar info={status} />
      {hint && <Hint key={hint.key} text={hint.text} />}
      {menu && (
        <WorkModeMenu
          ref={menuRef}
          x={menu.x}
          y={menu.y}
          types={source?.types ?? []}
          picks={source?.picks ?? []}
          charsPerKey={session?.charsPerKey ?? options.charsPerKey}
          panel={options.panel}
          automatic={automatic}
          onPicks={(picks) => void applyPicks(picks)}
          onChars={(n) => void applyOptions({ charsPerKey: n })}
          onPanel={(on) => void applyOptions({ panel: on })}
          onAutomatic={setAutomatic}
          onLeave={startLeaving}
        />
      )}
    </div>
  )
}
