## Workstream F — sidebar, spacing and platform

Covers spec §4.F plus §2.10 and §2.11. **Every task here assumes contract Tasks 1–5 have landed**
(`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`): the `--space-*`,
`--lh-*`, `--icon-*`, `--scrim`, `--swatch-ring`, `--shadow-panel`, `--on-danger` and
`--traffic-lights-w` tokens are *declared* by contract Task 4, `Tab` already carries `kind` and
`selectedPath`, and `clampUiScale` / `clampFontSize` already run inside `hydrateSettings`. This
workstream is what *uses* all of that.

Ordering, and why it is this order. The four sidebar behaviour fixes (111–115) come first because
each is small, independently visible, and none of them depends on the spacing work. The spacing and
token work (116–121) comes last in the whole overhaul because it moves pixels on every screen —
landing it before the behaviour fixes would mean every later screenshot is arguing with two changes
at once. Task 110 comes before all of them because every defect in §2.10 and §2.11 was *established*
by measuring the running window, and so has to be closed by measuring it: there is no DOM test
runner in this repo, so a reusable CDP probe is the test harness for nine of these thirteen tasks.
Task 122 is the density review the spec asks for, and it runs after everything else has moved.

Two facts worth carrying into every task below, both measured against this repo today:

- Contract Task 4's migration touches **`app.css` only** — its `perl` runs on one file and its
  `grep` checks one file. **26 inline `var(--sp-*)` uses remain in eight `.tsx` files** and will
  resolve to nothing (invalid at computed-value time → `gap` collapses to 0) until Task 116 runs.
- The contract's `--on-danger: #ffffff` **fails WCAG AA**: white measures 2.89 / 2.84 / 2.70 against
  Ember's, Nocturne's and Moss's `--danger`, and two of its three call sites are button *text*.
  Task 121 changes the value (not the name) and adds the assertion that catches it.

---

### Task 110: A CDP probe, because every fix below is a measurement

Spec §5: "UI work is verified by launching with `--remote-debugging-port` and driving over CDP". No
such tool exists in the repo. This builds it once so the twelve tasks after it each get a one-line
test command.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs`
- Modify: none
- Test: the script itself, run against a live window (step 3)

**Interfaces:**
- Consumes: `ws` (already a production dependency in `package.json`); global `fetch` (Node ≥18);
  the CDP HTTP endpoint at `http://127.0.0.1:9222/json/list`.
- Produces: a CLI — `node scripts/cdp-eval.mjs "<expression>"` prints the JSON value of the
  expression evaluated in Stoke's renderer; `node scripts/cdp-eval.mjs --shot <file.png>` writes a
  screenshot. Honours `CDP_PORT` (default `9222`). Exit 0 on success, 1 on a thrown expression or a
  missing target, 2 on bad usage.

- [ ] **Step 1: Write the probe.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs` with exactly this content:

  ```js
  /*
   * Drive Stoke's own renderer over CDP: evaluate one expression, or take a
   * screenshot.
   *
   *   npm run build
   *   npx electron . --remote-debugging-port=9222 &
   *   node scripts/cdp-eval.mjs "document.querySelectorAll('.project').length"
   *   node scripts/cdp-eval.mjs --shot /tmp/stoke-sidebar.png
   *
   * Deliberately NOT part of `npm run check`: it needs a live window. It exists
   * because the UI defects in this codebase are geometric — they were
   * established by measuring, so they can only be closed by measuring.
   *
   * The docked browser is its own CDP target (CLAUDE.md gotcha 6), so targets
   * are matched on URL, never on `type === 'page'`, which would drive whatever
   * page the browser panel happens to be showing.
   *
   * xterm renders through WebGL, so terminal *content* is only ever readable
   * from --shot, never from textContent (CLAUDE.md gotcha 5).
   */
  import { writeFileSync } from 'node:fs'
  import WebSocket from 'ws'

  const port = process.env.CDP_PORT ?? '9222'
  const wantsShot = process.argv[2] === '--shot'
  const arg = wantsShot ? process.argv[3] : process.argv[2]

  if (!arg) {
    console.error('usage: node scripts/cdp-eval.mjs "<expression>"')
    console.error('       node scripts/cdp-eval.mjs --shot <file.png>')
    process.exit(2)
  }

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const app = targets.find(
    (t) =>
      t.type === 'page' &&
      (t.url.includes('/out/renderer/index.html') || t.url.includes('localhost:5173'))
  )
  if (!app) {
    console.error(`no Stoke renderer on port ${port}. Targets seen:`)
    for (const t of targets) console.error(`  ${t.type}  ${t.url}`)
    process.exit(1)
  }

  const ws = new WebSocket(app.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  /** One request, matched back by id — replies and events share the socket. */
  function send(id, method, params) {
    return new Promise((resolve) => {
      const onMessage = (data) => {
        const msg = JSON.parse(String(data))
        if (msg.id !== id) return
        ws.off('message', onMessage)
        resolve(msg)
      }
      ws.on('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  if (wantsShot) {
    const reply = await send(1, 'Page.captureScreenshot', { format: 'png' })
    writeFileSync(arg, Buffer.from(reply.result.data, 'base64'))
    console.log(arg)
  } else {
    const reply = await send(1, 'Runtime.evaluate', {
      expression: arg,
      returnByValue: true,
      awaitPromise: true
    })
    if (reply.result.exceptionDetails) {
      console.error(
        reply.result.exceptionDetails.exception?.description ??
          reply.result.exceptionDetails.text
      )
      ws.close()
      process.exit(1)
    }
    console.log(JSON.stringify(reply.result.result.value, null, 2))
  }
  ws.close()
  ```

- [ ] **Step 2: Run it with nothing listening, and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "1 + 1"`
  Expected: it throws on the `fetch`, printing
  `TypeError: fetch failed` with `cause: ... ECONNREFUSED 127.0.0.1:9222`. That is the harness
  proving it really talks to a live window rather than to nothing.

- [ ] **Step 3: Launch the app and run it for real.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke
  npm run build
  npx electron . --remote-debugging-port=9222 &
  sleep 6
  node scripts/cdp-eval.mjs "getComputedStyle(document.documentElement).getPropertyValue('--space-8').trim()"
  ```

  Expected output: `"0.5rem"` — which also confirms contract Task 4's token block landed. Then
  `node scripts/cdp-eval.mjs --shot /tmp/stoke-before.png` and expect it to print
  `/tmp/stoke-before.png`. Keep that window running; every task below reuses it.

- [ ] **Step 4: Commit.**
  ```bash
  git add scripts/cdp-eval.mjs
  git commit -m "Add a CDP probe, because UI defects here are measurements not opinions"
  ```
  Body records: every geometry bug in spec §2.10 and §2.11 was found by measuring the running
  window and none of them is reachable from a typecheck; xterm's WebGL renderer leaves
  `.xterm-rows` empty so terminal output is only ever confirmable from a screenshot; and the docked
  browser is a second CDP target, so targets are matched on URL.

---

### Task 111: Clicking a project stops tearing down the running terminal

Spec §2.10: `App.tsx:698-701` sets `activeTabId` to `null` on every project click, and `App.tsx:769`
hides `.term-stack` on exactly that condition. Glancing at another project's session list therefore
removes the session you are running from the screen.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — add `selectProject` above
  the `return` (near `resumeSession`, currently lines 649-661); rewrite `onSelectProject`
  (currently lines 698-701) and `onToggleExpand` (currently lines 702-705); rewrite the
  `CommandPalette` `onPick` (currently lines 879-883).
- Test: `node scripts/cdp-eval.mjs` (Task 110), step 2 below.

**Interfaces:**
- Consumes: `Tab.kind: TabKind` and `Tab.selectedPath: string | null` (contract §0.7, landed by
  contract Task 2 step 7); React `useCallback`, already imported at `App.tsx:1`.
- Produces: `const selectProject: (path: string) => void` in `App.tsx` — sets the sidebar's own
  selection and, when the active tab is a New Project tab, that tab's `selectedPath`. It never
  writes `activeTabId`.

- [ ] **Step 1: Measure the defect.** With the window from Task 110 running:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const scratch = [...document.querySelectorAll('.sidebar-head .btn')]
      .find((b) => b.textContent.includes('Scratch'))
    scratch.click()
    for (let i = 0; i < 40 && !document.querySelector('.term-stack .term-pane'); i++) await sleep(250)
    const before = getComputedStyle(document.querySelector('.term-stack')).display
    document.querySelector('.project').click()
    await sleep(200)
    return {
      before,
      after: getComputedStyle(document.querySelector('.term-stack')).display,
      selected: document.querySelector('.project[aria-current=\\\"true\\\"]') !== null
    }
  })()"
  ```

  Expected now: `{ "before": "block", "after": "none", "selected": true }` — the terminal was on
  screen and one project click removed it.

- [ ] **Step 2: Add the `selectProject` helper.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, immediately **above** the
  `resumeSession` definition (currently line 649), insert:

  ```tsx
  /**
   * Select a project in the sidebar. It does **not** touch `activeTabId`.
   *
   * It used to, and `.term-stack` is hidden while `activeTabId` is null, so
   * glancing at another project's session list tore down the view of the
   * session you were running. Which project is selected is a sidebar concern;
   * which tab is on screen is not, and conflating them made the sidebar feel
   * destructive to use.
   *
   * A New Project tab keeps its own selection (`Tab.selectedPath`), so several
   * can be open on different folders at once — that is why the selection is
   * written onto the active tab as well as into the sidebar's own state.
   */
  const selectProject = useCallback(
    (path: string): void => {
      setSelectedPath(path)
      setTabs((list) =>
        list.map((t) =>
          t.id === activeTabId && t.kind === 'new' ? { ...t, selectedPath: path } : t
        )
      )
    },
    [activeTabId]
  )
  ```

- [ ] **Step 3: Point the three call sites at it.** In the same file, replace the `onSelectProject`
  and `onToggleExpand` props on `<Sidebar>` (currently lines 698-705):

  ```tsx
                onSelectProject={(p) => selectProject(p.path)}
                onToggleExpand={(p) => {
                  selectProject(p.path)
                  setExpandedPath((cur) => (cur === p.path ? null : p.path))
                }}
  ```

  and replace the `CommandPalette` `onPick` (currently lines 879-883) with:

  ```tsx
          onPick={(p) => {
            setPaletteOpen(false)
            selectProject(p.path)
          }}
  ```

  Leave `openFolder` (currently line 606) alone — picking a *new* folder is workstream D's, and its
  `setActiveTabId(null)` is deliberate there: there is nothing yet to look at in that folder.

- [ ] **Step 4: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected:
  `{ "before": "block", "after": "block", "selected": true }`.

- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "Stop a project click from hiding the session you are running"
  ```
  Body records the bug: `onSelectProject` cleared `activeTabId` and `.term-stack` is display:none on
  that condition, so selecting a project in the sidebar removed a live terminal from the screen; the
  command palette had the same defect.

---

### Task 112: Enter and Space do what the row's own click does

Spec §2.10: Enter starts a session and Space selects. The row carries `role="button"`, and the one
promise that role makes is that Enter and Space both fire what a click fires — so a keyboard user
pressing the obvious key got a spawned `claude` process instead of the selection the mouse gives.
The double-click escalation keeps a keyboard route of its own.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — the
  `onKeyDown` handler and `title` on `.project` (currently lines 247-256).
- Test: `node scripts/cdp-eval.mjs`, step 3 below.

**Interfaces:**
- Consumes: the existing `Props` callbacks `onSelectProject: (p: Project) => void` and
  `onStartNew: (p: Project) => void` (`Sidebar.tsx:18-20`). No prop changes.
- Produces: no new exports. Behaviour: `Enter` and `Space` → `onSelectProject`;
  `Cmd+Enter` / `Ctrl+Enter` → `onStartNew`.

- [ ] **Step 1: Measure the defect.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = document.querySelectorAll('.project')[1] ?? document.querySelector('.project')
    row.focus()
    const tabsBefore = document.querySelectorAll('.tabs .tab').length
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(1500)
    return {
      current: row.getAttribute('aria-current'),
      tabsBefore,
      tabsAfter: document.querySelectorAll('.tabs .tab').length
    }
  })()"
  ```

  Expected now: `tabsAfter` is `tabsBefore + 1` and `current` is `"false"` — Enter spawned a session
  and selected nothing.

- [ ] **Step 2: Correct the mapping.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx`, replace the
  `onKeyDown` and `title` on the `.project` div (currently lines 247-256) with:

  ```tsx
                    onKeyDown={(e) => {
                      /*
                       * Enter and Space both do exactly what a click does.
                       *
                       * This row announces itself as `role="button"`, and the
                       * one promise that role makes is that both keys fire the
                       * element's own click. It used to start a session on
                       * Enter and select on Space, so assistive tech said
                       * "button", the user pressed the obvious key, and got a
                       * spawned process instead of a selection.
                       *
                       * Starting a session is the double-click escalation, so
                       * it keeps a modifier of its own rather than losing its
                       * keyboard route. metaKey OR ctrlKey, so the component
                       * needs no platform prop to be right on both.
                       */
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        onStartNew(project)
                      } else if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectProject(project)
                      }
                    }}
                    title={`${project.path}\nEnter selects · Cmd/Ctrl+Enter starts a session`}
  ```

- [ ] **Step 3: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `current` is `"true"` and `tabsAfter` equals
  `tabsBefore` — Enter selected the row and started nothing.

- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "Make Enter on a project row do what clicking it does"
  ```
  Body records the bug: the row is `role="button"` but Enter started a session while Space selected,
  so the key every convention makes primary was the one that spawned a process.

---

### Task 113: Selection out-ranks hover, on every theme, measurably

Spec §2.10: `.project:hover` uses `--surface-hover` and `.project[aria-current]` uses `--surface`,
and in all three dark themes the hover reads stronger — the selected project looks less chosen than
whatever the mouse is over. This is measurable, so it is measured rather than eyeballed.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts` — imports (lines 12-19) and a
  new block before the final tally (line 112);
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — the `:root` token block, and
  `.project:hover` / `.project[aria-current='true']` / `.project[aria-current='true'] .project-name`
  (currently lines 730-737 and 756-758).
- Test: `npm run verify:color`

**Interfaces:**
- Consumes: `parseColor`, `over`, `perceptualDistance`, `contrastRatio`, `Rgb` from
  `src/shared/color.ts`; `BUILT_IN_THEMES` from `src/shared/themes.ts`; `Theme` from
  `src/shared/types.ts`.
- Produces: **new CSS token** `--surface-selected: color-mix(in srgb, var(--accent) 18%, var(--surface-hover))`
  (not in the shared contracts — declared here, reused by Task 114). It follows the live `--accent`,
  so it tracks a profile switch with no extra writer.

- [ ] **Step 1: Encode today's rule as an assertion, and watch it fail.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts`, extend the import block (lines 12-19)
  to:

  ```ts
  import {
    apcaContrast,
    contrastRatio,
    over,
    parseColor,
    perceptualDistance,
    toHex,
    toOklch
  } from '../src/shared/color.ts'
  import type { Rgb } from '../src/shared/color.ts'
  import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
  import type { Theme } from '../src/shared/types.ts'
  ```

  and insert this block immediately **before** the final
  `console.log(failures ? \`\n${failures} failure(s)\` : '\nall colour checks pass')` line:

  ```ts
  console.log('\n-- the sidebar: selection must out-rank hover --')
  /*
   * The selected project has to read as more chosen than the row the mouse
   * happens to be over. That is a distance, not a taste: how far each state
   * sits from the panel it is drawn on. Hover is `--surface-hover`; selection
   * is whatever `selectedBg` returns, which must stay in step with
   * `--surface-selected` in app.css. If you change one, change the other —
   * this is the assertion that catches it.
   */
  function selectedBg(t: Theme): Rgb {
    return parseColor(t.colors.surface)!
  }

  for (const t of BUILT_IN_THEMES) {
    const panel = parseColor(t.colors.bgSunken)!
    const hoverD = perceptualDistance(panel, over(parseColor(t.colors.surfaceHover)!, panel))
    const selD = perceptualDistance(panel, over(selectedBg(t), panel))
    const ok = selD > hoverD
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: selection vs hover`.padEnd(46)} ${selD
        .toFixed(4)
        .padStart(10)}  (expected > ${hoverD.toFixed(4)})`
    )
  }

  for (const t of BUILT_IN_THEMES) {
    // The row's own label still has to be readable on whatever selection is.
    const bg = over(selectedBg(t), parseColor(t.colors.bgSunken)!)
    const ratio = contrastRatio(parseColor(t.colors.text)!, bg)
    const ok = ratio >= 4.5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: label on a selected row`.padEnd(46)} ${ratio
        .toFixed(2)
        .padStart(10)}  (expected >= 4.5)`
    )
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && npm run verify:color`
  Expected, exactly:

  ```
  -- the sidebar: selection must out-rank hover --
  FAIL ember: selection vs hover                            0.0792  (expected > 0.1136)
  FAIL nocturne: selection vs hover                         0.0873  (expected > 0.1279)
  FAIL moss: selection vs hover                             0.0950  (expected > 0.1339)
  ok   daylight: selection vs hover                         0.0536  (expected > 0.0181)
  ```

  followed by four `ok` label lines and `3 failure(s)`, exit 1. The three dark themes are exactly
  the three spec §2.10 named.

- [ ] **Step 3: Add the token.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, inside the `:root` block,
  immediately after the `--space-*` scale added by contract Task 4, add:

  ```css
    /*
     * A selected row. Accent-tinted rather than a lighter grey on purpose: a
     * grey selection cannot out-rank a grey hover without becoming a third
     * shade nobody can rank on sight. 18% is the smallest mix that beats hover
     * on all four built-in themes — asserted in scripts/verify-color.mts.
     *
     * It reads `--accent` at use time, so it follows a profile switch with no
     * second writer touching :root.
     */
    --surface-selected: color-mix(in srgb, var(--accent) 18%, var(--surface-hover));
  ```

- [ ] **Step 4: Apply it.** In the same file, replace the three project rules (currently at lines
  730-737 and 756-758) with:

  ```css
  .project:hover {
    background: var(--surface-hover);
  }

  /*
   * Selection out-ranks hover.
   *
   * `--surface` measured *closer* to the panel than `--surface-hover` on all
   * three dark themes, so the row the mouse was over read as more chosen than
   * the row that actually was, and the sidebar read as broken rather than
   * merely subtle. The command palette already had the right idea
   * (`.palette-item[data-active='true']`, an accent wash); this is the same
   * move with enough accent in it to win on every theme.
   *
   * The hover pair is restated so a selected row does not drop back to the
   * hover grey under the pointer.
   */
  .project[aria-current='true'],
  .project[aria-current='true']:hover {
    background: var(--surface-selected);
    border-color: transparent;
  }
  ```

  ```css
  /*
   * `--text`, not `--accent`. The background now carries the selection, and
   * accent-on-selected measures 4.27:1 on Nocturne and 3.59:1 on Daylight —
   * under AA. Weight carries the emphasis instead, which costs no contrast.
   */
  .project[aria-current='true'] .project-name {
    color: var(--text);
    font-weight: 600;
  }
  ```

- [ ] **Step 5: Move the suite onto the new recipe and watch it pass.** In
  `scripts/verify-color.mts`, replace the `selectedBg` function added in step 1 with:

  ```ts
  /** `--surface-selected` in app.css: color-mix(in srgb, accent 18%, surface-hover). */
  const SELECTED_ACCENT_MIX = 0.18

  function selectedBg(t: Theme): Rgb {
    const a = parseColor(t.colors.accent)!
    const b = over(parseColor(t.colors.surfaceHover)!, parseColor(t.colors.bgSunken)!)
    const p = SELECTED_ACCENT_MIX
    return {
      r: a.r * p + b.r * (1 - p),
      g: a.g * p + b.g * (1 - p),
      b: a.b * p + b.b * (1 - p),
      a: 1
    }
  }
  ```

  Run `npm run verify:color`. Expected, exactly:

  ```
  -- the sidebar: selection must out-rank hover --
  ok   ember: selection vs hover                            0.2152  (expected > 0.1136)
  ok   nocturne: selection vs hover                         0.2181  (expected > 0.1279)
  ok   moss: selection vs hover                             0.2409  (expected > 0.1339)
  ok   daylight: selection vs hover                         0.0658  (expected > 0.0181)
  ok   ember: label on a selected row                         8.88  (expected >= 4.5)
  ok   nocturne: label on a selected row                      8.57  (expected >= 4.5)
  ok   moss: label on a selected row                          8.00  (expected >= 4.5)
  ok   daylight: label on a selected row                     11.46  (expected >= 4.5)
  ```

  ending `all colour checks pass`, exit 0.

- [ ] **Step 6: Commit.**
  ```bash
  git commit -am "Make a selected project out-shout a hovered one, and prove it"
  ```
  Body records the bug and the numbers: selection used `--surface` and hover `--surface-hover`, which
  measured 0.0792 vs 0.1136 from the panel on Ember and the same way round on Nocturne and Moss, so
  the selected row was the quieter of the two; and accent-coloured selected text would have measured
  4.27:1 on Nocturne, so the emphasis moved to weight.

---

### Task 114: The session behind the open terminal is marked as such

Spec §2.10: there is no `aria-current`, `data-active` or `aria-selected` on any `.session` rule at
all, so the session you are running is drawn identically to the eleven you are not.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — `Props`
  (lines 9-34), the destructure (lines 36-56), a memo, and the `.session` button (lines 327-332);
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` — a memo plus one new `<Sidebar>`
  prop; `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — two new rules after
  `.session:hover` (currently lines 810-812).
- Test: `node scripts/cdp-eval.mjs`, step 1 and step 5 below.

**Interfaces:**
- Consumes: `Tab.sessionId: string` (`src/renderer/src/types.ts`); `SessionMeta.id: string`
  (`@shared/types`); the `--surface-selected` token from Task 113.
- Produces: new `Sidebar` prop `openSessionIds: string[]` — "session ids that currently have a tab
  open". Passed from `App.tsx` as a memo over `tabs`.

- [ ] **Step 1: Measure the defect.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.project')].find((r) => /\\\\d+ session/.test(r.textContent))
    row.querySelector('.project-top button').click()
    for (let i = 0; i < 40 && !document.querySelector('.sessions .session'); i++) await sleep(250)
    document.querySelector('.sessions .session').click()
    for (let i = 0; i < 60 && !document.querySelector('.tabs .tab'); i++) await sleep(250)
    await sleep(800)
    const hit = document.querySelector('.sessions .session[aria-current=\\\"true\\\"]')
    return {
      marked: document.querySelectorAll('.sessions .session[aria-current=\\\"true\\\"]').length,
      bg: hit ? getComputedStyle(hit).backgroundColor : null
    }
  })()"
  ```

  Expected now: `{ "marked": 0, "bg": null }`.

- [ ] **Step 2: Take the new prop in `Sidebar`.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx`, add to `Props`
  immediately after `sessionsLoading: boolean` (line 16):

  ```tsx
  /**
   * Session ids that currently have a tab open. The row backing the terminal
   * you are looking at is the one row in this list worth finding again, and it
   * had no state of its own at all.
   */
  openSessionIds: string[]
  ```

  add `openSessionIds,` to the destructured parameter list immediately after `sessionsLoading,`
  (line 43), and add this memo immediately after the `available` binding (line 61):

  ```tsx
  /* A Set so a project with a long history is one lookup per row, not a scan. */
  const openSessions = useMemo(() => new Set(openSessionIds), [openSessionIds])
  ```

- [ ] **Step 3: Mark the row.** In the same file, replace the opening tag of the session button
  (currently lines 327-332) with:

  ```tsx
                          <button
                            key={s.id}
                            className="session"
                            aria-current={openSessions.has(s.id) ? 'true' : undefined}
                            onClick={() => onResume(s)}
                            title={s.firstPrompt ?? s.id}
                          >
  ```

- [ ] **Step 4: Feed it from `App`.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, immediately after the `activeTab`
  binding (currently line 554), add:

  ```tsx
  /* Memoised: a fresh array each render would rebuild the Sidebar's Set on every tick. */
  const openSessionIds = useMemo(() => tabs.map((t) => t.sessionId), [tabs])
  ```

  and add the prop to `<Sidebar>` immediately after `sessionsLoading={sessionsLoading}`
  (currently line 696):

  ```tsx
                openSessionIds={openSessionIds}
  ```

- [ ] **Step 5: Give it a state.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, immediately after the
  `.session:hover` rule (currently lines 810-812), add:

  ```css
  /*
   * The session behind the open terminal. There was no such state at all, so
   * the one row you were actually looking at and the twelve you were not were
   * drawn identically. Same wash as a selected project, because it means the
   * same thing one level down.
   */
  .session[aria-current='true'] {
    background: var(--surface-selected);
  }

  .session[aria-current='true'] .session-title {
    font-weight: 600;
  }
  ```

- [ ] **Step 6: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `"marked": 1`, and `bg` a non-transparent
  colour — `"rgb(81, 57, 42)"` on the default Ember theme (the 18% accent mix; the triple differs
  per theme and per active profile).

- [ ] **Step 7: Commit.**
  ```bash
  git commit -am "Mark the session row the open terminal is running"
  ```
  Body records: no `.session` rule carried any selected state, so the row backing the live terminal
  was indistinguishable from every other row in the list.

---

### Task 115: One vertical for a project's name, its metadata and its sessions

Spec §2.10: the nested session list is outdented from its parent project title, and the project's
metadata line hangs left of the project's own name, so a row reads as two fragments. Both are the
same defect — three things that belong on one vertical are on three.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — `:root` (one new
  token), `.project-meta` (currently lines 760-766), `.project-pin` (currently lines 774-777),
  `.sessions` (currently lines 787-794), and one new `.project-chevron` rule;
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx` — the chevron button
  (currently lines 259-278) and the pin button (currently lines 282-294).
- Test: `node scripts/cdp-eval.mjs`, step 1 and step 5 below.

**Interfaces:**
- Consumes: `--space-4`, `--space-8` (contract Task 4); `--dur`, `--dur-fast`, `--ease`, `--border`
  (existing).
- Produces: **new CSS token** `--chevron: 1.125rem` (not in the shared contracts) and two new
  classes, `.project-chevron` and a widened `.project-pin`. `--chevron` exists because three rules
  have to agree about the disclosure control's box: the button itself, the metadata indent, and
  where the session list's guide rule falls.

- [ ] **Step 1: Measure the two offsets.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.project')].find((r) => /\\\\d+ session/.test(r.textContent))
    row.querySelector('.project-top button').click()
    for (let i = 0; i < 40 && !document.querySelector('.sessions .session'); i++) await sleep(250)
    const name = row.querySelector('.project-name').getBoundingClientRect().left
    const meta = row.querySelector('.project-meta > *').getBoundingClientRect().left
    const title = row.parentElement.querySelector('.sessions .session-title').getBoundingClientRect().left
    return [Math.round(meta - name), Math.round(title - name)]
  })()"
  ```

  Expected now: `[-26, -5]` — the metadata sits 26px left of the name it describes, and a session
  title 5px left of the project it belongs to. (Both were 24px and 4px before contract Task 4 moved
  `--sp-2` from 6px to 8px; the defect is unchanged, the arithmetic shifted.)

- [ ] **Step 2: Name the chevron's box.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, in the `:root` block
  immediately after `--surface-selected` (Task 113), add:

  ```css
    /*
     * The disclosure chevron's box. Named because three rules have to agree
     * with it: the button itself, the project metadata's indent, and where the
     * session list's guide rule falls. It was an inline style in Sidebar.tsx,
     * which is exactly how the three drifted apart.
     */
    --chevron: 1.125rem;
  ```

- [ ] **Step 3: Move the two inline sizes into CSS.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Sidebar.tsx`, replace the chevron
  button (currently lines 259-278) with:

  ```tsx
                      <button
                        className="icon-btn project-chevron"
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleExpand(project)
                        }}
                        aria-expanded={expanded}
                        title={expanded ? 'Hide sessions' : 'Show sessions'}
                      >
                        <IconChevron width={12} height={12} />
                        <span className="sr-only">
                          {expanded ? 'Hide sessions' : 'Show sessions'}
                        </span>
                      </button>
  ```

  and replace the pin button's opening tag (currently lines 282-285) with:

  ```tsx
                      <button
                        className="icon-btn project-pin"
                        aria-pressed={project.pinned}
  ```

  (the `style={{ width: '1.25rem', height: '1.25rem' }}` line is deleted; the rest of the pin
  button is unchanged). The `width={12} height={12}` on `IconChevron` and `IconPin` stay for now —
  Task 117 removes every icon size attribute in one pass.

- [ ] **Step 4: Put the three on one vertical.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace `.project-meta`
  (currently lines 760-766), `.project-pin` (currently lines 774-777) and `.sessions` (currently
  lines 787-794) with:

  ```css
  .project-meta {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    /* Indented to start under the project's own name rather than under the
       chevron's left edge. Unindented, the row read as two fragments 26px
       apart: a title over here, its own session count over there. */
    padding-left: calc(var(--chevron) + var(--space-8));
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  ```

  ```css
  .project-chevron {
    width: var(--chevron);
    height: var(--chevron);
    transition: rotate var(--dur) var(--ease);
  }

  .project-chevron[aria-expanded='true'] {
    rotate: 90deg;
  }

  /* The pin stays out of the way until the row is hovered, focused, or pinned —
     otherwise it repeats down the whole list as pure noise. */
  .project-pin {
    width: 1.25rem;
    height: 1.25rem;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  ```

  ```css
  .sessions {
    display: flex;
    flex-direction: column;
    gap: 1px;
    /*
     * The guide rule falls on the centre of the disclosure chevron, and the two
     * paddings past it add up to the chevron's other half plus the gap after
     * it — so a session title starts on exactly the same pixel as the project
     * name above it. 8 + 9 = 17 to the rule, + 1 border + 8 + 8 = 34, which is
     * .project's padding (8) + the chevron (18) + .project-top's gap (8).
     * Measured, not reasoned: it used to sit 5px to the left of the title it
     * belongs to, which is enough to read as a mistake and not enough to read
     * as a decision.
     */
    margin: var(--space-4) 0 var(--space-8) calc(var(--space-8) + var(--chevron) / 2);
    padding-left: var(--space-8);
    border-left: 1px solid var(--border);
  }
  ```

  The Launcher's "Resume a session" list overrides `margin`, `paddingLeft` and `borderLeft` inline
  (`Launcher.tsx:318`), so it is unaffected by all three.

- [ ] **Step 5: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `[0, 0]`. Then capture the sidebar:
  `node scripts/cdp-eval.mjs --shot /tmp/stoke-sidebar-aligned.png` and confirm from the image that
  the guide rule sits under the chevron and the three text runs share one left edge.

- [ ] **Step 6: Commit.**
  ```bash
  git commit -am "Put a project's name, its metadata and its sessions on one vertical"
  ```
  Body records: `.project-meta` was unindented while its own title sat 26px in, and `.sessions`'
  left margin put every session title 5px left of the project it belongs to; the chevron's size was
  an inline style, which is why the three rules that must agree about it had drifted.

---

### Task 116: Finish the 4px migration — the 26 inline uses `app.css` did not cover

Contract Task 4 migrated `app.css` with a `perl` over one file and checked it with a `grep` over
that same file. **26 `var(--sp-*)` uses remain in eight `.tsx` files.** Until they are migrated they
name a token that no longer exists, which is invalid at computed-value time — so those gaps and
paddings are currently rendering at 0. Mapping is the contract's, verbatim: `--sp-2` and `--sp-3` →
`--space-8`, `--sp-4` → `--space-12`, `--sp-6` → `--space-24`. Do not invent a mapping.

**Files:**
- Create: none
- Modify, all under `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/`:
  `HostsSettings.tsx` (177, 178, 183), `Launcher.tsx` (189, 247, 315), `ProfilesSettings.tsx`
  (278, 279, 284, 373, 382, 418, 419, 433, 492), `CommandPalette.tsx` (91), `Sidebar.tsx` (186, 363),
  `SettingsSheet.tsx` (191, 241), `RemoteSettings.tsx` (80, 234, 381, 487, 524),
  `WorklogSettings.tsx` (117).
- Test: the `grep` in steps 1 and 3, and the CDP measurement in step 4.

**Interfaces:**
- Consumes: `--space-8`, `--space-12`, `--space-24` (contract Task 4).
- Produces: nothing new. After this task `grep -rn -- '--sp-' src/` must return zero hits
  repo-wide — the greppability is the whole reason the contract renamed rather than renumbered.

- [ ] **Step 1: Count what is left, and watch it be non-zero.**
  `cd /Users/thevinh/dev/personal/stoke && grep -rn -- '--sp-' src/ | wc -l`
  Expected: `26`. If it is `0`, contract Task 4 was extended to cover `.tsx` and this task is
  already done; if it is more than 26, list them with `grep -rn -- '--sp-' src/` and migrate those
  too by the same table.

- [ ] **Step 2: Migrate them in one pass.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke/src/renderer/src/components && \
  perl -pi -e 's/var\(--sp-2\)/var(--space-8)/g;  s/var\(--sp-3\)/var(--space-8)/g;
               s/var\(--sp-4\)/var(--space-12)/g; s/var\(--sp-6\)/var(--space-24)/g;' \
    HostsSettings.tsx Launcher.tsx ProfilesSettings.tsx CommandPalette.tsx \
    Sidebar.tsx SettingsSheet.tsx RemoteSettings.tsx WorklogSettings.tsx
  ```

- [ ] **Step 3: Prove nothing was missed.**
  `cd /Users/thevinh/dev/personal/stoke && grep -rn -- '--sp-' src/ | wc -l`
  Expected: `0`. Any remaining hit is the migration's entire risk — fix it before moving on.

- [ ] **Step 4: Rebuild, relaunch, and measure a gap that was collapsed.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  node scripts/cdp-eval.mjs "getComputedStyle([...document.querySelectorAll('.sidebar-head > div')].pop()).columnGap"
  ```

  That element is the Open / Scratch button row, whose `gap` was `var(--sp-2)`. Expected after this
  task: `"8px"`. Before it: `"normal"` — the declaration was invalid, so the two buttons were
  touching.

- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "Migrate the inline spacing the app.css sweep could not reach"
  ```
  Body records: the token rename was chosen so a missed use fails loudly, and 26 of them were in
  `style={{ }}` objects rather than in the stylesheet — so the Open/Scratch row, the profile chip
  rows and five settings sections were rendering with their gaps collapsed to 0 until now.

---

### Task 117: Icons size themselves in rem, so Interface scale moves them too

Spec §2.11: every SVG is a fixed px attribute (`Icons.tsx:7-9`), so Interface scale resizes every
button and leaves every glyph behind — a 37.5% linear (61% areal) change between scale 1.0 and 1.6.
The mechanism is the contract's (§0.6), applied here.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Icons.tsx` (`Base`, lines
  4-23); `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (a new `.icon` rule,
  plus `--icon-size` on six containers); and the fifteen call sites listed in step 4.
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 6.

**Interfaces:**
- Consumes: `--icon-xs` (0.625rem), `--icon-sm` (0.75rem), `--icon-md` (0.875rem), `--icon-lg` (1rem)
  — all declared by contract Task 4.
- Produces: a `.icon` class emitted by `Base`, and the rule
  `.icon { width: var(--icon-size, var(--icon-lg)); height: var(--icon-size, var(--icon-lg)); flex: none }`.
  A container states its glyph size by setting `--icon-size`; no pixel count passes through a React
  prop again.

- [ ] **Step 1: Measure the defect.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const root = document.documentElement
    const read = () => {
      const btn = document.querySelector('.titlebar-actions .icon-btn')
      return [
        Math.round(btn.getBoundingClientRect().width),
        Math.round(btn.querySelector('svg').getBoundingClientRect().width)
      ]
    }
    const out = {}
    for (const s of ['1', '1.6']) {
      root.style.setProperty('--ui-scale', s)
      await sleep(80)
      out[s] = read()
    }
    root.style.setProperty('--ui-scale', '1')
    return out
  })()"
  ```

  Expected now: `{ "1": [28, 16], "1.6": [45, 16] }` — the button grew 60% and the glyph did not
  move at all.

- [ ] **Step 2: Stop `Base` emitting pixel attributes.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/Icons.tsx`, replace the `Base`
  function (lines 3-23) with:

  ```tsx
  /**
   * One consistent icon vocabulary: 16px grid, 1.5 stroke, round caps.
   *
   * No `width`/`height` attributes. Size comes from the `.icon` rule in
   * app.css, in rem, so a glyph grows with Interface scale — every icon used to
   * be a fixed px attribute, which is why scale 1.0 → 1.6 moved every button
   * 37.5% linear and left every glyph exactly where it was. A container states
   * its size by setting `--icon-size`.
   *
   * `{...rest}` stays last so a caller can still override viewBox and stroke
   * width, which IconGear does.
   */
  function Base(props: SVGProps<SVGSVGElement>): React.JSX.Element {
    const { children, className, ...rest } = props
    return (
      <svg
        className={className ? `icon ${className}` : 'icon'}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {children}
      </svg>
    )
  }
  ```

- [ ] **Step 3: Add the one rule that sizes every icon.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, immediately after the
  `.truncate` rule (currently lines 148-152), add:

  ```css
  /*
   * One rule sizes every icon. A container states its size by setting
   * --icon-size; nothing passes a pixel count through a React prop.
   * `flex: none` because an icon beside a truncating label must not be the
   * thing that shrinks.
   */
  .icon {
    width: var(--icon-size, var(--icon-lg));
    height: var(--icon-size, var(--icon-lg));
    flex: none;
  }
  ```

- [ ] **Step 4: Delete every size attribute at the call sites.** Remove the
  `width={n} height={n}` props from these fifteen `Icons.tsx` usages, leaving the rest of each tag
  untouched. The `width={180} height={180}` at `RemoteSettings.tsx:110-111` is an `<img>` QR code,
  **not** an `Icons.tsx` glyph — leave it alone.

  | File | Line today | Tag |
  |---|---|---|
  | `components/TitleBar.tsx` | 122 | `<IconClose width={11} height={11} />` → `<IconClose />` |
  | `components/BrowserPanel.tsx` | 143 | `<IconClose width={10} height={10} />` → `<IconClose />` |
  | `components/BrowserPanel.tsx` | 150 | `<IconPlus width={13} height={13} />` → `<IconPlus />` |
  | `components/BrowserPanel.tsx` | 162 | `<IconAsk width={13} height={13} />` → `<IconAsk />` |
  | `components/BrowserPanel.tsx` | 170 | `<IconMinus width={13} height={13} />` → `<IconMinus />` |
  | `components/BrowserPanel.tsx` | 178 | `<IconPlus width={13} height={13} />` → `<IconPlus />` |
  | `components/BrowserPanel.tsx` | 186 | `<IconCode width={13} height={13} />` → `<IconCode />` |
  | `components/BrowserPanel.tsx` | 318 | `<IconArrowLeft width={13} height={13} />` → `<IconArrowLeft />` |
  | `components/BrowserPanel.tsx` | 327 | `<IconArrowRight width={13} height={13} />` → `<IconArrowRight />` |
  | `components/BrowserPanel.tsx` | 331 | `<IconClose width={13} height={13} />` → `<IconClose />` |
  | `components/SettingsSheet.tsx` | 253 | `<IconClose width={12} height={12} />` → `<IconClose />` |
  | `components/ProfilesSettings.tsx` | 343 | `<IconClose width={12} height={12} />` → `<IconClose />` |
  | `components/HostsSettings.tsx` | 220 | `<IconClose width={12} height={12} />` → `<IconClose />` |
  | `components/Sidebar.tsx` | 274 | `<IconChevron width={12} height={12} />` → `<IconChevron />` |
  | `components/Sidebar.tsx` | 292 | `<IconPin width={12} height={12} />` → `<IconPin />` |

  The three `width={12}` buttons that are not otherwise classed need a size hook. Add
  `data-size="sm"` to each of those three `<button className="icon-btn" …>` tags —
  `SettingsSheet.tsx:247`, `ProfilesSettings.tsx:338`, `HostsSettings.tsx:215` — so each reads
  `<button className="icon-btn" data-size="sm"` (matching the `data-size` idiom `.btn` already uses
  at `app.css:1480`).

- [ ] **Step 5: Let the containers state their sizes.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add these declarations. Put
  the first inside the existing `.tab-close` rule (currently lines 346-362), the second immediately
  after it, the third inside the `.project-chevron` and `.project-pin` rules from Task 115, and the
  last two after `.browser-find-count` (currently lines 1140-1147):

  ```css
    /* was width={11}; the nearest token is 12px and the difference is invisible */
    --icon-size: var(--icon-sm);
  ```

  ```css
  /* The browser's own tab close is a size smaller — its tabs are shorter. */
  .btab .tab-close {
    --icon-size: var(--icon-xs);
  }
  ```

  ```css
    --icon-size: var(--icon-sm);
  ```

  ```css
  .browser-tabs .icon-btn,
  .browser-find .icon-btn {
    --icon-size: var(--icon-md);
  }

  /* Remove-this-row buttons in the settings sheet, profiles and hosts lists. */
  .icon-btn[data-size='sm'] {
    --icon-size: var(--icon-sm);
  }
  ```

- [ ] **Step 6: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected: `{ "1": [28, 16], "1.6": [45, 26] }` — the
  glyph now grows with the button. Then confirm the size hooks landed:

  ```bash
  node scripts/cdp-eval.mjs "[
    Math.round(document.querySelector('.tab-close svg').getBoundingClientRect().width),
    Math.round(document.querySelector('.project-chevron svg').getBoundingClientRect().width)
  ]"
  ```

  Expected: `[12, 12]`.

- [ ] **Step 7: Run the full check and commit.**
  ```bash
  npm run check
  git commit -am "Size icons in rem, so Interface scale moves the glyphs and not just the buttons"
  ```
  Body records: every icon was a fixed px attribute, so scale 1.0 → 1.6 grew each button 37.5%
  linear (61% areal) and left its glyph at exactly 16px; sizes now come from one `.icon` rule and a
  container's `--icon-size`, so no pixel count passes through a React prop.

---

### Task 118: One control height, and a line height for single-line controls

Spec §2.11: "inner control paddings bypass [the scale] entirely, producing nine near-but-unequal
control heights", and there is no line-height token. Contract Task 4 declared `--lh-tight`,
`--lh-snug` and `--lh-normal` and put `--lh-normal` on `body`; `--lh-tight` is unused so far. 28px
is the target because the tab strip and title bar are already built on it — it is the reason the
contract rounded `--sp-2` up rather than down.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — `:root` (one new
  token), `.btn` (currently 439-457), `.icon-btn` (508-521), `.input` (538-549), `.select` (566-585),
  `.segmented` (597-603) and `.segmented button` (605-617), `.pill` (635-646).
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 4.

**Interfaces:**
- Consumes: `--space-8`, `--space-12`, `--lh-tight` (contract Task 4).
- Produces: **new CSS token** `--control-h: 1.75rem` (not in the shared contracts) — the single
  height every control in the app is drawn at.

- [ ] **Step 1: Measure the nine-heights problem.** Against the running window, with a New Project
  tab on screen so the launcher's `<select>` exists:

  ```bash
  node scripts/cdp-eval.mjs "['.btn', '.input', '.select', '.icon-btn', '.segmented'].map((s) => {
    const el = document.querySelector(s)
    return [s, el ? Math.round(el.getBoundingClientRect().height) : null]
  })"
  ```

  Expected now: four different numbers — `.icon-btn` at `28` and `.btn` / `.input` / `.select`
  around `34`, with `.segmented` around `30`. Record whatever it actually prints; the exact
  pre-change figures move with the font stack, and it is the *disagreement* that is the defect.

- [ ] **Step 2: Add the token.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, in `:root` immediately after
  `--chevron` (Task 115), add:

  ```css
    /*
     * Every control the same height. 28px because the tab strip and the title
     * bar are already built on it — it is the number the whole shell's vertical
     * rhythm is measured against, and it is why the spacing scale rounded 6px
     * up to 8 rather than down to 4.
     *
     * Nine near-but-unequal heights were the symptom of every control setting
     * its own vertical padding and inheriting whatever line height happened to
     * apply.
     */
    --control-h: 1.75rem;
  ```

- [ ] **Step 3: Apply it.** In the same file, change these declarations — every other line in each
  rule stays exactly as it is:

  - `.btn`: replace `padding: 0.375rem var(--space-12);` with
    `height: var(--control-h);` then `padding: 0 var(--space-12);` then
    `line-height: var(--lh-tight);`
  - `.icon-btn`: replace `width: 1.75rem;` / `height: 1.75rem;` with
    `width: var(--control-h);` / `height: var(--control-h);`
  - `.input`: replace `padding: 0.375rem var(--space-8);` with
    `height: var(--control-h);` then `padding: 0 var(--space-8);` then
    `line-height: var(--lh-tight);`
  - `.select`: replace `padding: 0.375rem 1.75rem 0.375rem var(--space-8);` with
    `height: var(--control-h);` then `padding: 0 1.75rem 0 var(--space-8);` then
    `line-height: var(--lh-tight);`
  - `.segmented`: add `height: var(--control-h);` after `padding: 2px;`
  - `.segmented button`: replace `padding: 0.25rem var(--space-8);` with
    `padding: 0 var(--space-8);` then add `line-height: var(--lh-tight);`
  - `.pill`: add `line-height: var(--lh-tight);` after `font-weight: 500;`

  `.palette-input` is a separate class and keeps its own generous padding — the command palette's
  field is a page-level input, not a control in a row of controls.

- [ ] **Step 4: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected, exactly:
  `[[".btn",28],[".input",28],[".select",28],[".icon-btn",28],[".segmented",28]]`.

- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "Draw every control at one height, and give single-line controls a line height"
  ```
  Body records: nine near-but-unequal control heights came from each control setting its own
  vertical padding on top of an inherited line height; 28px is the height the tab strip and title
  bar were already built on.

---

### Task 119: The Interface-scale field stops advertising bounds the store will not honour

Spec §2.11: `uiScale` is never clamped on the write path, because a number input's `min`/`max` are
advisory inside React's `onChange`. Contract Task 3 landed the enforcement in `hydrateSettings`, so
a junk value can no longer be *stored*. What is left is the display half: the terminal-size field
still advertises 8–28 while the store enforces 9–24, and both handlers still invent their own
fallback (`|| 1`, `|| 13`) rather than using the shared clamp — so `0` becomes `1` here and `0.8`
there.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/SettingsSheet.tsx` —
  imports (lines 1-11), the Terminal size field (107-117), the Interface scale field (119-131).
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 4.

**Interfaces:**
- Consumes: `clampUiScale`, `clampFontSize`, `UI_SCALE_MIN`, `UI_SCALE_MAX`, `FONT_SIZE_MIN`,
  `FONT_SIZE_MAX` from `@shared/ui` (contract §0.6, created by contract Task 2 step 3).
- Produces: nothing new. One source of truth for the bounds, shown and enforced.

- [ ] **Step 1: Measure the lie.** Against the running window:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.titlebar-actions .icon-btn[title=\\\"Settings\\\"]').click()
    await sleep(400)
    const field = (label) => [...document.querySelectorAll('.sheet-body .field')]
      .find((f) => f.textContent.startsWith(label)).querySelector('input')
    const size = field('Terminal size')
    const scale = field('Interface scale')
    return { size: [size.min, size.max], scale: [scale.min, scale.max] }
  })()"
  ```

  Expected now: `{ "size": ["8", "28"], "scale": ["0.8", "1.6"] }` — the spinner offers 8 and 28,
  and the store silently stores 9 and 24.

- [ ] **Step 2: Import the shared bounds.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/SettingsSheet.tsx`, add after the
  `BUILT_IN_THEMES` import (line 3):

  ```tsx
  import {
    clampFontSize,
    clampUiScale,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    UI_SCALE_MAX,
    UI_SCALE_MIN
  } from '@shared/ui'
  ```

- [ ] **Step 3: Show and apply the same numbers.** Replace the two fields (currently lines 107-131)
  with:

  ```tsx
            <div className="field">
              <span className="field-label">Terminal size</span>
              <input
                className="input"
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={settings.fontSize}
                onChange={(e) => onPatch({ fontSize: clampFontSize(e.target.value) })}
              />
            </div>

            <div className="field">
              <span className="field-label">Interface scale</span>
              {/*
                min/max are advisory inside React's onChange — the browser will
                not stop a typed or pasted value reaching the handler — so the
                same clamp the store enforces is applied here too, and the two
                bounds come from one place. The field used to offer 8-28 for a
                store that accepts 9-24, and to fall back with `|| 1`, which
                turned a typed 0 into 1 rather than into the floor.
              */}
              <input
                className="input"
                type="number"
                min={UI_SCALE_MIN}
                max={UI_SCALE_MAX}
                step={0.05}
                value={settings.uiScale}
                onChange={(e) => onPatch({ uiScale: clampUiScale(e.target.value) })}
              />
              <span className="field-hint">Scales everything except the terminal contents.</span>
            </div>
  ```

- [ ] **Step 4: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected:
  `{ "size": ["9", "24"], "scale": ["0.8", "1.6"] }`. Then prove a typed value is clamped rather
  than fallen back on:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const input = [...document.querySelectorAll('.sheet-body .field')]
      .find((f) => f.textContent.startsWith('Interface scale')).querySelector('input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, '0')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(500)
    const out = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()
    set.call(input, '1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(500)
    return out
  })()"
  ```

  Expected: `"0.8"` — the floor, not the `|| 1` fallback. (Setting `.value` through the prototype's
  native setter is required: React tracks input values internally and ignores a plain assignment.)

- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "Show the same interface-scale bounds the store enforces"
  ```
  Body records: the terminal-size field advertised 8-28 against a store that accepts 9-24, and both
  handlers used `|| n` fallbacks that turned a typed 0 into 1 rather than into the floor; a number
  input's min/max are advisory inside React's onChange, so the clamp has to be called, not declared.

---

### Task 120: macOS traffic-light clearance in device pixels

Spec §2.11: `app.css:216` clears the traffic lights with `padding-left: 4.875rem` — a rem — while
the lights are drawn by macOS at a fixed device size that Interface scale does not touch. Stoke is
only correctly laid out on macOS at Interface scale exactly 1.0.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — the
  `.titlebar[data-platform='darwin']` rule (currently lines 214-217).
- Test: `node scripts/cdp-eval.mjs`, steps 1 and 3. **Must be run on macOS**; the rule does not
  match on any other platform.

**Interfaces:**
- Consumes: `--traffic-lights-w: 78px` (contract Task 4; 78 = 4.875 × 16, so scale 1.0 is
  pixel-identical to today and every other scale is fixed).
- Produces: nothing new.

- [ ] **Step 1: Measure the defect.** Against the running window on macOS:

  ```bash
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const root = document.documentElement
    const out = {}
    for (const s of ['0.8', '1', '1.6']) {
      root.style.setProperty('--ui-scale', s)
      await sleep(80)
      out[s] = getComputedStyle(document.querySelector('.titlebar')).paddingLeft
    }
    root.style.setProperty('--ui-scale', '1')
    return out
  })()"
  ```

  Expected now, exactly: `{ "0.8": "62.4px", "1": "78px", "1.6": "124.8px" }` — at 0.8 the first tab
  sits under the close button, and at 1.6 the strip starts 47px further in than it should.

- [ ] **Step 2: Make it px.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the rule at lines
  214-217 with:

  ```css
  /*
   * Clear the macOS traffic lights.
   *
   * Device pixels, never rem. The lights are drawn by macOS at a fixed size
   * that Stoke's Interface scale does not touch, so a rem clearance is only
   * correct at scale exactly 1.0 — which is the whole of why Stoke was only
   * laid out correctly on a Mac at that one setting. 78px is 4.875rem x 16, so
   * scale 1.0 is unchanged and every other scale is fixed.
   */
  .titlebar[data-platform='darwin'] {
    padding-left: var(--traffic-lights-w);
  }
  ```

- [ ] **Step 3: Rebuild, relaunch, and watch it pass.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  ```

  Re-run the exact expression from step 1. Expected, exactly:
  `{ "0.8": "78px", "1": "78px", "1.6": "78px" }`. Then capture proof at both extremes:

  ```bash
  node scripts/cdp-eval.mjs "document.documentElement.style.setProperty('--ui-scale', '1.6')"
  node scripts/cdp-eval.mjs --shot /tmp/stoke-titlebar-160.png
  node scripts/cdp-eval.mjs "document.documentElement.style.setProperty('--ui-scale', '0.8')"
  node scripts/cdp-eval.mjs --shot /tmp/stoke-titlebar-080.png
  node scripts/cdp-eval.mjs "document.documentElement.style.setProperty('--ui-scale', '1')"
  ```

  Confirm from both images that no tab is under a traffic light and no gap has opened beside them.

- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "Clear the macOS traffic lights in device pixels, not rem"
  ```
  Body records: the clearance was `4.875rem` against controls macOS draws at a fixed device size, so
  Stoke was only correctly laid out on a Mac at Interface scale exactly 1.0 — at 0.8 the first tab
  sat under the close button.

---

### Task 121: The last untokenised colours, and the ink that goes on a danger fill

Spec §2.11 lists three literals (`app.css:1565` `.backdrop`, `:1795` `.theme-chip`, `:2004`
`.usage-panel`) and four `#fff`. CLAUDE.md is explicit that all colour goes through custom
properties. **The contract's `--on-danger: #ffffff` is wrong and this task fixes it:** white measures
2.89 / 2.84 / 2.70 against Ember's, Nocturne's and Moss's `--danger`, and two of its three sites are
button *text*. `var(--bg)` clears 4.5:1 on every built-in theme, needs no light-mode override, and
stays right for a custom theme by construction.

**Files:**
- Create: none
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts` — one new block before the
  final tally; `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` — the
  `--on-danger` declaration in `:root` (contract Task 4), `.win-btn[data-variant='close']:hover`
  (currently 432-435), `.btn[data-variant='danger']:hover:not(:disabled)` (502-506),
  `.segmented button[data-danger='true'][aria-pressed='true']` (630-633), `.backdrop` (1561-1567),
  `.theme-chip` (1792-1797), `.usage-panel` (1991-2005), `.usage-pace` (2082-2094).
- Test: `npm run verify:color`, then `node scripts/cdp-eval.mjs` in step 5.

**Interfaces:**
- Consumes: `--scrim`, `--swatch-ring`, `--shadow-panel`, `--on-danger` (all declared by contract
  Task 4, with the light-appearance overrides for the first three); `contrastRatio`, `parseColor`
  and `BUILT_IN_THEMES`, already imported into `verify-color.mts` by Task 113.
- Produces: **a changed value for a contract-pinned token** — `--on-danger: var(--bg)` instead of
  `#ffffff`, and no light-appearance override, because `--bg` already flips.

- [ ] **Step 1: Assert the contract's value, and watch it fail.** In
  `/Users/thevinh/dev/personal/stoke/scripts/verify-color.mts`, insert this block immediately
  before the final `console.log(failures ? … )` line:

  ```ts
  console.log('\n-- ink on a danger fill --')
  /*
   * Two of the three `--on-danger` sites are button text, so this is a 4.5:1
   * bar, not a 3:1 one. The token has to clear it against every theme's danger
   * fill — a fill that is itself chosen for visibility, which is exactly why a
   * light ink on it does not work.
   */
  const ON_DANGER = (t: Theme): string => '#ffffff'

  for (const t of BUILT_IN_THEMES) {
    const ratio = contrastRatio(parseColor(ON_DANGER(t))!, parseColor(t.colors.danger)!)
    const ok = ratio >= 4.5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`--on-danger on ${t.id}'s danger`.padEnd(46)} ${ratio
        .toFixed(2)
        .padStart(10)}  (expected >= 4.5)`
    )
  }
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && npm run verify:color`
  Expected, exactly:

  ```
  -- ink on a danger fill --
  FAIL --on-danger on ember's danger                            2.89  (expected >= 4.5)
  FAIL --on-danger on nocturne's danger                         2.84  (expected >= 4.5)
  FAIL --on-danger on moss's danger                             2.70  (expected >= 4.5)
  ok   --on-danger on daylight's danger                         6.01  (expected >= 4.5)
  ```

  and `3 failure(s)`, exit 1.

- [ ] **Step 3: Change the token's value, and the suite with it.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the
  `--on-danger: #ffffff;` declaration that contract Task 4 added to `:root` with:

  ```css
    /*
     * Text and marks on a --danger fill.
     *
     * NOT white. White measures 2.89 / 2.84 / 2.70 against Ember's, Nocturne's
     * and Moss's danger — under half of AA — and two of the three sites are
     * button text. `--bg` is the token that already flips with appearance, it
     * clears 4.5:1 against every built-in danger with room to spare, and it
     * stays right for a custom theme without anyone remembering to check.
     * Asserted in scripts/verify-color.mts.
     */
    --on-danger: var(--bg);
  ```

  If contract Task 4 also added an `--on-danger` line to the `:root[data-appearance='light']`
  block, delete it: `--bg` flips on its own and a second declaration would freeze it.

  Then in `scripts/verify-color.mts`, replace the `ON_DANGER` binding from step 1 with:

  ```ts
  /** `--on-danger: var(--bg)` in app.css. If you change one, change the other. */
  const ON_DANGER = (t: Theme): string => t.colors.bg
  ```

- [ ] **Step 4: Run it and watch it pass.**
  `npm run verify:color`
  Expected, exactly:

  ```
  -- ink on a danger fill --
  ok   --on-danger on ember's danger                            6.50  (expected >= 4.5)
  ok   --on-danger on nocturne's danger                         6.66  (expected >= 4.5)
  ok   --on-danger on moss's danger                             6.85  (expected >= 4.5)
  ok   --on-danger on daylight's danger                         5.46  (expected >= 4.5)
  ```

  ending `all colour checks pass`, exit 0.

- [ ] **Step 5: Replace the seven literals.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`:

  | Rule (line today) | Change |
  |---|---|
  | `.backdrop` (1565) | `background: rgb(0 0 0 / 0.42);` → `background: var(--scrim);` |
  | `.theme-chip` (1796) | `border: 1px solid rgb(0 0 0 / 0.25);` → `border: 1px solid var(--swatch-ring);` |
  | `.usage-panel` (2004) | `box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);` → `box-shadow: var(--shadow-panel);` |
  | `.win-btn[data-variant='close']:hover` (434) | `color: #fff;` → `color: var(--on-danger);` |
  | `.btn[data-variant='danger']:hover:not(:disabled)` (505) | `color: #fff;` → `color: var(--on-danger);` |
  | `.segmented button[data-danger='true'][aria-pressed='true']` (632) | `color: #fff;` → `color: var(--on-danger);` |
  | `.usage-pace` (2088) | `background: #fff;` → `background: var(--text);` |

  `.usage-pace` gets `--text` and no new token: it is a 2px pace marker ringed in `--bg-sunken`, and
  a white bar is invisible on a light theme while `--text` already flips. Add above it:

  ```css
    /* --text, not white: this bar has to read on a light theme too, and --text
       is the token that already flips with appearance. The --bg-sunken ring
       below is what separates it from whatever fill it is standing on. */
  ```

  Then prove no literal survives:
  `grep -n '#fff\|rgb(0 0 0' /Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`
  Expected: only hits inside the `:root` / `:root[data-appearance='light']` token blocks and the
  `--shadow-sm/md/lg` declarations — never inside a component rule.

- [ ] **Step 6: Rebuild, relaunch, and confirm the two that are visible.**

  ```bash
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.titlebar-actions .icon-btn[title=\\\"Settings\\\"]').click()
    await sleep(400)
    return {
      scrim: getComputedStyle(document.querySelector('.backdrop')).backgroundColor,
      chip: getComputedStyle(document.querySelector('.theme-chip')).borderTopColor
    }
  })()"
  ```

  Expected on the default Ember (dark) theme: `{ "scrim": "rgba(0, 0, 0, 0.42)", "chip": "rgba(0, 0, 0, 0.25)" }`
  — identical to before, which is the point: the values did not change, only where they live.

- [ ] **Step 7: Run the full check and commit.**
  ```bash
  npm run check
  git commit -am "Tokenise the last literal colours, and put a legible ink on danger fills"
  ```
  Body records the bug found while doing it: `--on-danger` was specified as `#ffffff`, which measures
  2.70-2.89:1 against the dark themes' danger reds — under half of AA on two sites that are button
  text — so it is `var(--bg)`, which clears 4.5:1 on all four built-in themes and needs no light
  override.

---

### Task 122: The density review — every screen, after everything has moved

Spec §4.F.6: "This is a visible density change; every screen is reviewed afterwards." Ninety-two
declarations moved to 8px, three to 24px, every control is now 28px, every glyph now scales, and
the sidebar's whole left edge moved. This is the task that looks at all of it.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/docs/superpowers/plans/parts/F-density-review/` (seven
  PNGs; a scratch directory, not shipped code)
- Modify: only whatever the review turns up, plus `CLAUDE.md` in step 5
- Test: the measurements in step 2 and the seven screenshots in step 3

**Interfaces:**
- Consumes: `scripts/cdp-eval.mjs` (Task 110) and every change from Tasks 111-121.
- Produces: no code interfaces. A recorded before/after, and a CLAUDE.md gotcha.

- [ ] **Step 1: Rebuild and relaunch clean.**

  ```bash
  cd /Users/thevinh/dev/personal/stoke
  pkill -f 'electron .*--remote-debugging-port=9222'
  npm run build && npx electron . --remote-debugging-port=9222 &
  sleep 6
  mkdir -p docs/superpowers/plans/parts/F-density-review
  ```

- [ ] **Step 2: Take the whole set of measurements at once.**

  ```bash
  node scripts/cdp-eval.mjs "({
    controls: ['.btn', '.input', '.select', '.icon-btn', '.segmented'].map((s) => {
      const el = document.querySelector(s)
      return [s, el ? Math.round(el.getBoundingClientRect().height) : null]
    }),
    tabPadding: getComputedStyle(document.querySelector('.tab')).paddingInline,
    sidebarGap: getComputedStyle([...document.querySelectorAll('.sidebar-head > div')].pop()).columnGap,
    bodyLineHeight: getComputedStyle(document.body).lineHeight,
    trafficLights: getComputedStyle(document.querySelector('.titlebar')).paddingLeft,
    iconLg: getComputedStyle(document.documentElement).getPropertyValue('--icon-lg').trim()
  })"
  ```

  Expected, exactly, on macOS at Interface scale 1.0:

  ```json
  {
    "controls": [[".btn", 28], [".input", 28], [".select", 28], [".icon-btn", 28], [".segmented", 28]],
    "tabPadding": "8px",
    "sidebarGap": "8px",
    "bodyLineHeight": "21.7px",
    "trafficLights": "78px",
    "iconLg": "1rem"
  }
  ```

  (`21.7px` is `--lh-normal` 1.55 × the 14px `--fs-base`; if the body font size differs on the
  machine, the number is `1.55 × fs-base` and must not be a bare `normal`.)

- [ ] **Step 3: Capture all seven screens.** Run each pair in order; each `--shot` writes into
  `docs/superpowers/plans/parts/F-density-review/`.

  ```bash
  S=docs/superpowers/plans/parts/F-density-review
  # 1. launcher + sidebar, nothing selected
  node scripts/cdp-eval.mjs --shot $S/1-launcher.png
  # 2. sidebar with a project expanded
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.project')].find((r) => /\\\\d+ session/.test(r.textContent))
    row.click(); row.querySelector('.project-top button').click()
    for (let i = 0; i < 40 && !document.querySelector('.sessions .session'); i++) await sleep(250)
    return document.querySelectorAll('.sessions .session').length
  })()"
  node scripts/cdp-eval.mjs --shot $S/2-sidebar-expanded.png
  # 3. a live terminal (WebGL: only a screenshot can confirm it renders)
  node scripts/cdp-eval.mjs "(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.sessions .session').click()
    for (let i = 0; i < 60 && !document.querySelector('.term-stack .term-pane'); i++) await sleep(250)
    await sleep(3000)
    return getComputedStyle(document.querySelector('.term-stack')).display
  })()"
  node scripts/cdp-eval.mjs --shot $S/3-terminal.png
  # 4. settings sheet
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title=\\\"Settings\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/4-settings.png
  node scripts/cdp-eval.mjs "document.querySelector('.backdrop').click()"
  # 5. command palette
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title^=\\\"Find a project\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/5-palette.png
  node scripts/cdp-eval.mjs "document.querySelector('.backdrop').click()"
  # 6. worklog panel
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title^=\\\"Worklog\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/6-worklog.png
  # 7. browser panel
  node scripts/cdp-eval.mjs "document.querySelector('.titlebar-actions .icon-btn[title^=\\\"Toggle browser\\\"]').click()"
  node scripts/cdp-eval.mjs --shot $S/7-browser.png
  ```

  Read all seven. Four things to look for specifically, because they are what the migration could
  plausibly have broken: a control whose label now touches its own border (`--sp-2`'s 6→8px only
  ever added room, so this would mean a fixed `height` clipping); a settings section whose gap
  shrank from 28px to 24px and now reads as a list rather than as sections; an icon that grew from
  11px to 12px inside a box that was exactly 11px; and anything in the terminal pane, which is a
  WebGL canvas whose contents are readable from nowhere but this image.

- [ ] **Step 4: Fix what the images show, one commit per fix.** Any correction is a change to a
  single rule in `app.css` re-measured with the same expression from step 2. Do not adjust the
  scale itself — the mapping is the contract's and a one-off exception is how the old
  4/6/8/12/16/20/28/40 scale grew in the first place.

- [ ] **Step 5: Record the two things worth not rediscovering.** Append to the "Gotchas that cost
  real time" list in `/Users/thevinh/dev/personal/stoke/CLAUDE.md`:

  ```md
  21. **A CSS token rename only fails loudly if the old name is gone.** The spacing migration renamed
      `--sp-*` to `--space-*` on purpose: a missed `var(--sp-2)` names nothing, the declaration is
      invalid at computed-value time, and the padding visibly collapses to 0. Renumbering in place
      would have made `--sp-4` silently mean 4px where it used to mean 12px. Two consequences: the
      migration is verified by `grep -rn -- '--sp-' src/` returning **zero**, and a sweep over the
      stylesheet is not the whole job — 26 uses were inside `style={{ }}` objects in eight `.tsx`
      files and rendered at 0 until they were found.

  22. **macOS traffic lights are device pixels; anything clearing them must be too.** `padding-left`
      in rem was only correct at Interface scale exactly 1.0 — at 0.8 the first tab sat under the
      close button. Same class of bug as sizing an icon with a px attribute inside a rem-scaled
      button: two units that do not move together, so it looks right at exactly one setting.
  ```

- [ ] **Step 6: Run the full check and commit.**
  ```bash
  npm run check
  git add docs/superpowers/plans/parts/F-density-review CLAUDE.md
  git commit -m "Review every screen after the 4px migration, and record what it cost to learn"
  ```
  Body records: 92 declarations moved to 8px and three to 24px, every control is now 28px and every
  glyph now scales with Interface scale; the seven screenshots are the evidence that the density
  change is a change and not a regression.
