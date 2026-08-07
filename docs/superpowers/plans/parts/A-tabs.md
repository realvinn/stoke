## Workstream A — title bar and Chrome-style tabs

Covers design §4.A and the defects recorded in §2.6, §2.7 and §2.8.

**Reads with:** `/Users/thevinh/dev/personal/stoke/docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md`
(authoritative), `/Users/thevinh/dev/personal/stoke/docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`
(Tasks 1–5 there **must** have landed first — every task below imports something they create),
`/Users/thevinh/dev/personal/stoke/CLAUDE.md`.

**Ordering, and why it is this order.** Task 80 builds the measuring instrument, because every
geometry defect in §2.6 was *established* by measurement and cannot be confirmed any other way —
xterm draws into a canvas (gotcha 5) and reading CSS proves nothing (gotcha 14). Tasks 81–82 then
fix the two geometry defects while the strip is still simple, so each measurement has exactly one
cause. Tasks 83–85 rebuild the indicator: the fixed slot first, then the colour semantics, then the
worklog signal that fills the slot's centre — in that order because the slot has to exist before
anything can be centred in it, and red has to be freed before it can be reassigned. Task 86 makes
`permissionMode` honest, which the indicator has been reading since 83. Tasks 87–88 are two small
independent corrections. Tasks 89–92 are the New Project tab, decomposed into four steps that each
leave the app working: the session cache first (pure refactor), then the tab kind, then per-tab
launcher state, then the `+` button that creates them. Task 93 adds reorder, which needs the tab
list to be final. Task 94 closes the loop by re-measuring everything at once.

**Two constraints from CLAUDE.md that bound every task here.** `.app` is a fixed three-row grid
(`titlebar / body / status`) with an explicit `grid-template-columns: minmax(0, 1fr)` — do not add a
row, and do not remove that column declaration; a native `WebContentsView` paints above all renderer
DOM, so nothing here may become an overlay (gotcha 14). And `align-self: center` centres the
**margin** box, so cancelling a container's padding for one child needs the *full* padding negated,
not half (gotcha 11) — `app.css:294-297` already does this for the `+` button and its comment says
so; read it before touching `.tabs`.

---

### Task 80: A CDP measuring instrument for the renderer

Every geometry task below states an exact number. Without a repeatable way to read that number from
the running app, the numbers are decoration. This builds the instrument once.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs`
- Test: the script itself, run twice — once with nothing listening, once against the live app.

**Interfaces:**
- Consumes: `ws` (already a runtime dependency, `package.json`), the Chrome DevTools Protocol
  endpoint exposed by `--remote-debugging-port`.
- Produces: `node scripts/cdp-eval.mjs "<expression>"` → prints `JSON.stringify(result)` on stdout,
  exit 0; exit 1 when no endpoint or no Stoke renderer; exit 2 on usage error. Reads `CDP_PORT`
  (default `9222`).

- [ ] **Step 1: Write the harness.**
  Create `/Users/thevinh/dev/personal/stoke/scripts/cdp-eval.mjs` with exactly this content:

  ```js
  /*
   * Evaluate one expression inside Stoke's own renderer and print the result.
   *
   *   npx electron . --remote-debugging-port=9222 &
   *   node scripts/cdp-eval.mjs "getComputedStyle(document.body).lineHeight"
   *
   * Why this exists: every alignment defect in the UX overhaul was established by
   * measuring the running app, and none of them can be seen any other way — the
   * terminal is a WebGL canvas (CLAUDE.md gotcha 5) and the CSS reads correct
   * while laying out wrong (gotcha 14).
   *
   * Targets are NOT filtered by `type === 'page'`. The docked browser is its own
   * page target (gotcha 6), so a script that takes the first page drives the
   * wrong one and reports confident nonsense. The renderer is identified by the
   * one thing only it has: a `window.stoke` contextBridge object.
   *
   * The expression may be async; its promise is awaited before the result is
   * serialised, which is what lets a test dispatch an event and then read the
   * DOM React rendered in response.
   */
  import WebSocket from 'ws'

  const port = process.env.CDP_PORT ?? '9222'
  const expression = process.argv.slice(2).join(' ')

  if (!expression) {
    console.error('usage: node scripts/cdp-eval.mjs "<javascript expression>"')
    process.exit(2)
  }

  let targets
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    targets = await res.json()
  } catch {
    console.error(
      `No CDP endpoint on port ${port}. Launch the app with --remote-debugging-port=${port} first.`
    )
    process.exit(1)
  }

  /** One request/response round trip on an open session. */
  async function send(ws, id, method, params) {
    return await new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id !== id) return
        ws.off('message', onMessage)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
      ws.on('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(ws, id, expr) {
    const result = await send(ws, id, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    }
    return result.result.value
  }

  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let hit = null

  for (const page of pages) {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const isStoke = await evaluate(
        ws,
        1,
        'typeof window.stoke === "object" && typeof window.stoke.platform === "string"'
      )
      if (isStoke) {
        hit = { page, ws }
        break
      }
    } catch {
      /* a target that will not talk is not the renderer */
    }
    ws.close()
  }

  if (!hit) {
    console.error(
      `No Stoke renderer among ${pages.length} page target(s): ` +
        `${pages.map((p) => p.url).join(', ') || 'none'}`
    )
    process.exit(1)
  }

  try {
    const value = await evaluate(
      hit.ws,
      2,
      `Promise.resolve((() => (${expression}))()).then((v) => JSON.stringify(v))`
    )
    console.log(value)
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    hit.ws.close()
    process.exit(1)
  }

  hit.ws.close()
  ```

- [ ] **Step 2: Run it with nothing listening, and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "1 + 1"
  ```
  Expected on stderr, exit code 1:
  `No CDP endpoint on port 9222. Launch the app with --remote-debugging-port=9222 first.`

- [ ] **Step 3: Launch the app with the debugger open.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && \
    npx electron . --remote-debugging-port=9222 &
  ```
  Leave it running for the rest of this workstream. Every measurement step below assumes it, and
  assumes the window is at its default size with the sidebar open.

- [ ] **Step 4: Run it against the live renderer and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "window.stoke.platform"
  ```
  Expected on stdout, exit code 0: `"darwin"`.
  Then prove the async path works:
  ```bash
  node scripts/cdp-eval.mjs "new Promise((r) => setTimeout(() => r(document.querySelectorAll('.tab').length), 20))"
  ```
  Expected: a number — `0` with no session open, `1` with one tab.

- [ ] **Step 5: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add scripts/cdp-eval.mjs && \
    git commit -m "Add a CDP probe for the renderer, so alignment claims can be measured

Every misalignment in the UX overhaul was found by measuring the running app and
none of them is visible any other way: the terminal is a WebGL canvas so its DOM
is empty, and the CSS reads correct while laying out wrong. The probe identifies
the renderer by window.stoke rather than by target type, because the docked
browser is its own page target and a naive filter drives the wrong page."
  ```

---

### Task 81: Reset the UA button padding, which is 2.5px of the tab-close offset

Chromium's UA sheet sets `button { padding: 1px 6px }`. The reset at `app.css:26-32` resets `font`
and `color` only, so that padding survives and leaves `.tab-close` — an 18px box — a **6px** content
box for an 11px glyph. The glyph overflows its grid area, alignment falls back to the start edge,
and the ✕ sits 6px from the left and 1px from the right. One declaration fixes this and every
`.icon-btn` in the app at the same time.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the reset block at
  lines 26–32)
- Test: `scripts/cdp-eval.mjs` measurements, before and after.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. A CSS-only change.

- [ ] **Step 1: Open a session so there is a tab to measure.**
  In the running app, start a session in any folder (the launcher's **Start here** button is
  enough). Confirm one tab exists:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "document.querySelectorAll('.tab').length"
  ```
  Expected: `1`.

- [ ] **Step 2: Measure the defect, and watch it fail.**
  `.tab-close` only becomes visible on hover, but it is laid out regardless, so no hover is needed.
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const b = document.querySelector('.tab-close'); const r = b.getBoundingClientRect(); const g = b.querySelector('svg').getBoundingClientRect(); return { left: +(g.left - r.left).toFixed(2), right: +(r.right - g.right).toFixed(2), pad: getComputedStyle(b).paddingLeft } })()"
  ```
  Expected: `{"left":6,"right":1,"pad":"6px"}` — the glyph is 5px further from the right edge than
  from the left, which is the 2.5px visual offset design §2.6 records.

  > If workstream F's icon-size change has already landed, the glyph is 12px rather than 11px and
  > this prints `{"left":6,"right":0,"pad":"6px"}`. The assertion that matters in both cases is
  > `left === right`, and it does not hold.

- [ ] **Step 3: Record every button's height, so the reset can be proved harmless.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "Object.fromEntries([...document.querySelectorAll('button')].map((b) => [b.className || '(none)', Math.round(b.getBoundingClientRect().height)]))"
  ```
  Save the printed JSON. Step 6 compares against it. Every button in this app either sets its own
  padding (`.btn`, `.segmented button`, `.project`, `.session`, `.btab`) or is a fixed-size grid box
  (`.icon-btn`, `.tab-close`, `.win-btn`), so the expected diff is **none**.

- [ ] **Step 4: Reset the padding.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the reset block:

  ```css
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }
  ```

  with:

  ```css
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  /*
   * Chromium's UA sheet sets `button { padding: 1px 6px }` and the reset above
   * never touched it. On an 18px `.tab-close` that leaves a 6px content box for
   * an 11px glyph: the glyph overflows its grid area, inline centring stops
   * applying, and the ✕ lands 6px from the left and 1px from the right. It gets
   * worse as Interface scale drops, because the rem-sized box shrinks while the
   * UA padding does not. Every button in this app that wants padding declares
   * it, so zeroing it here costs nothing and fixes `.tab-close` and every
   * `.icon-btn` in one line. Measured, not reasoned.
   */
  button {
    padding: 0;
  }
  ```

- [ ] **Step 5: Rebuild and measure again, and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload the renderer (`node scripts/cdp-eval.mjs "location.reload()"`, then reopen a session), and:
  ```bash
  node scripts/cdp-eval.mjs "(() => { const b = document.querySelector('.tab-close'); const r = b.getBoundingClientRect(); const g = b.querySelector('svg').getBoundingClientRect(); return { left: +(g.left - r.left).toFixed(2), right: +(r.right - g.right).toFixed(2), pad: getComputedStyle(b).paddingLeft } })()"
  ```
  Expected: `{"left":3.5,"right":3.5,"pad":"0px"}` (or `{"left":3,"right":3,"pad":"0px"}` if F's
  12px icon has landed). `left === right` is the assertion.

- [ ] **Step 6: Prove no other button changed height.**
  Re-run the command from Step 3 and diff its output against the saved JSON.
  Expected: byte-identical.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Zero the UA button padding, which was pushing every icon off centre

Chromium's UA sheet sets button padding 1px 6px and the reset only ever touched
font and colour. On the 18px .tab-close that left a 6px content box for an 11px
glyph, so the mark overflowed its grid area, inline centring stopped applying,
and the ✕ sat at 6px/1px instead of 3.5/3.5. The same padding eats into every
.icon-btn and gets worse as Interface scale drops, because the rem box shrinks
while the UA pixels do not."
  ```

---

### Task 82: Centre tab contents on the title bar's centreline

Every icon outside the tab strip centres at **y=21.5**; tab contents centre at **y=24.0**.
`.tabs` has `padding-top: var(--space-4)` with `align-items: stretch` (app.css:264-275), so a tab's
border box runs 4→43 and, with a 1px top border and `border-bottom: none`, its *content* box runs
5→43 and centres at 24.0. The tab's painted box must keep meeting the pane below, so the padding
cannot simply go: the content is pulled up instead.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the `.tab` rule,
  currently at lines 299–318)
- Test: `scripts/cdp-eval.mjs` centreline measurements.

**Interfaces:**
- Consumes: `--space-4` (contracts Task 4).
- Produces: nothing new. A CSS-only change.

- [ ] **Step 1: Measure all three centrelines, and watch the tab fail.**
  With one session tab open:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(2) }; return { icon: mid(document.querySelector('.titlebar-actions .icon-btn')), plus: mid(document.querySelector('.tabs > .icon-btn')), indicator: mid(document.querySelector('.tab-dot, .tab .ring')), label: mid(document.querySelector('.tab-label')) } })()"
  ```
  Expected: `{"icon":21.5,"plus":21.5,"indicator":24,"label":24}` — the strip's own contents are
  2.5px low against everything else in the bar, including the `+` button sitting beside them.

- [ ] **Step 2: Record where the tab's painted box ends, so the fix can be proved not to lift it.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const t = document.querySelector('.tab').getBoundingClientRect(); const h = document.querySelector('.titlebar').getBoundingClientRect(); return { tabTop: +t.top.toFixed(2), tabBottom: +t.bottom.toFixed(2), barBottom: +h.bottom.toFixed(2) } })()"
  ```
  Expected: `{"tabTop":4,"tabBottom":43,"barBottom":44}`. The tab ends at 43 — the title bar's
  content edge, with only its own 1px bottom border below it. This must not change.

- [ ] **Step 3: Pull the tab's contents up by the padding plus the border.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, in the `.tab` rule,
  replace the padding line:

  ```css
    padding: 0 var(--space-8) 0 var(--space-8);
  ```

  with:

  ```css
    /*
     * Three values: no top padding, 8px inline, and a bottom padding that is the
     * strip's own top padding plus the tab's top border.
     *
     * The strip is padded at the top and stretches its children, so a tab's
     * painted box runs from y=4 to the title bar's content edge and meets the
     * pane below — which is what makes it read as a tab. But the box has a 1px
     * top border and no bottom border, so its content box is 5px shorter at the
     * top than at the bottom and everything inside it centred at 24.0, while
     * every icon outside the strip centres at 21.5.
     *
     * Shortening the content box at the bottom by exactly that 5px moves the
     * centreline up 2.5px and leaves the painted box where it was. This is the
     * same trap as the `+` button below (see CLAUDE.md gotcha 11): the whole
     * offset has to be cancelled, not half of it. Measured, not reasoned.
     */
    padding: 0 var(--space-8) calc(var(--space-4) + 1px);
  ```

  > If contracts Task 4 has not landed yet the line reads `padding: 0 var(--sp-2) 0 var(--sp-3);`.
  > Stop and land Task 4 first — this workstream's tokens do not exist without it.

- [ ] **Step 4: Rebuild, then re-measure the centrelines, and watch them agree.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload the renderer and reopen a session, then re-run the Step 1 command.
  Expected: `{"icon":21.5,"plus":21.5,"indicator":21.5,"label":21.5}`.

- [ ] **Step 5: Prove the painted box did not move.**
  Re-run the Step 2 command.
  Expected: `{"tabTop":4,"tabBottom":43,"barBottom":44}` — unchanged.

- [ ] **Step 6: Screenshot the title bar.**
  Capture the running window (macOS: `screencapture -o -x /tmp/stoke-titlebar.png`) and look at it.
  The dot, the label, the ✕ and the icons on both sides must sit on one line. This is the check the
  numbers cannot make.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Sit tab contents on the title bar's centreline

Tab contents centred at y=24.0 while every icon in the same bar centred at 21.5,
including the + button four pixels away from them. The strip is padded at the top
and stretches its children so a tab's painted box meets the pane below, and the
tab has a top border and no bottom border, so its content box was 5px shorter at
the top. Cancelling that at the bottom moves the centreline without lifting the
painted box off the pane."
  ```

---

### Task 83: One fixed indicator slot, with the ring always present

Today a 7px `.tab-dot` is swapped for a 14px `.ring` the moment the context watcher becomes ready,
so the label and the ✕ jump 7px sideways with no transition — and the permission and exit states
vanish with the dot. This replaces both with a single 14px slot that is always the same width and
always draws a ring, empty when there is nothing to report.

**Files:**
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TabIndicator.tsx`
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ContextMeter.tsx`
  (the `ContextRing` export, lines 43–65)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (lines 1–17
  imports, 103–112 the dot/ring swap)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (delete the
  `.tab-dot` rules at 375–393; add the `.tab-indicator` block)
- Test: `scripts/cdp-eval.mjs` slot-width and label-position measurements.

**Interfaces:**
- Consumes: `--tab-indicator` (contracts Task 4), `ContextSnapshot` and `PermissionMode` from
  `@shared/types`, `Tab.kind` from `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts`
  (contracts Task 2).
- Produces:
  ```ts
  // src/renderer/src/components/ContextMeter.tsx
  export const RING_R = 5.6
  export function ContextRing(props: {
    used: number
    limit: number
    /** False before the watcher has read anything: draw the empty track only. */
    ready?: boolean
  }): React.JSX.Element

  // src/renderer/src/components/TabIndicator.tsx
  export function TabIndicator(props: {
    kind: TabKind
    context: ContextSnapshot | undefined
    status: 'running' | 'exited'
    permissionMode: PermissionMode
    watched: boolean
  }): React.JSX.Element
  ```

- [ ] **Step 1: Measure the jump, and watch it fail.**
  Open a *fresh* session and run this immediately, before the watcher reports (it polls at 1.5s):
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const l = document.querySelector('.tab-label').getBoundingClientRect(); const t = document.querySelector('.tab').getBoundingClientRect(); return +(l.left - t.left).toFixed(2) })()"
  ```
  Expected: `24` — the tab's 1px left border, its 8px left padding, the 7px dot and the 8px gap.
  Wait three seconds and run it again.
  Expected: `31` — the label has moved 7px right because the 7px dot became a 14px ring.

- [ ] **Step 2: Let `ContextRing` draw an empty ring.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/ContextMeter.tsx`, replace
  lines 43–65 with:

  ```tsx
  /** Radius of the tab ring, shared so anything drawn in the same slot lines up. */
  export const RING_R = 5.6
  const CIRC = 2 * Math.PI * RING_R

  /**
   * Compact ring for tab strips, where there is no room for a bar and caption.
   *
   * `ready` false draws the track and nothing else. That case exists because the
   * strip used to render a 7px dot until the watcher reported and then swap in a
   * 14px ring, which shoved the label and the close button 7px sideways with no
   * transition. An empty circle says the same thing — no reading yet — without
   * moving anything.
   */
  export function ContextRing({
    used,
    limit,
    ready = true
  }: {
    used: number
    limit: number
    ready?: boolean
  }): React.JSX.Element {
    const ratio = ready && limit > 0 ? Math.min(1, used / limit) : 0
    const pct = Math.round(ratio * 100)
    return (
      <svg className="ring" viewBox="0 0 16 16" data-level={ready ? level(ratio) : 'empty'}>
        <title>{ready ? `Context ${pct}% used` : 'Context not read yet'}</title>
        <circle className="ring-track" cx="8" cy="8" r={RING_R} />
        {ready && (
          <circle
            className="ring-fill"
            cx="8"
            cy="8"
            r={RING_R}
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - ratio)}
            strokeLinecap="round"
          />
        )}
      </svg>
    )
  }
  ```

- [ ] **Step 3: Write the indicator component.**
  Create `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TabIndicator.tsx`:

  ```tsx
  import type { ContextSnapshot, PermissionMode } from '@shared/types'
  import { ContextRing, RING_R } from './ContextMeter'
  import type { TabKind } from '../types'

  interface Props {
    kind: TabKind
    /** Undefined until the context watcher has reported for this session. */
    context: ContextSnapshot | undefined
    status: 'running' | 'exited'
    /**
     * The mode the transcript last recorded, not the one the tab launched with.
     * See the ContextSnapshot.permissionMode work in this workstream.
     */
    permissionMode: PermissionMode
    /** The worklog agent is watching this session. The only red in the strip. */
    watched: boolean
  }

  /**
   * Everything one tab has to say about its session, in a slot of fixed width.
   *
   * The slot is fixed because the strip used to swap a 7px dot for a 14px ring
   * the moment the context watcher became ready, and the label and the close
   * button jumped 7px with it. It is also the reason the ring is drawn even with
   * no reading: an empty circle occupies the slot honestly, where a blank space
   * would read as a rendering failure.
   *
   * The red dot in the middle means exactly one thing — the worklog agent is
   * watching this session. Bypass mode and a nearly-full ring both used to be
   * red as well, so red meant three unrelated things at once and therefore
   * nothing; both now have their own treatment.
   */
  export function TabIndicator({
    kind,
    context,
    status,
    permissionMode,
    watched
  }: Props): React.JSX.Element {
    if (kind === 'new') {
      /*
       * A New Project tab has no session, so there is nothing to measure. The
       * plus is drawn inline rather than pulled from Icons.tsx so it inherits
       * the ring's exact geometry and cannot drift out of the slot.
       */
      return (
        <span className="tab-indicator" data-kind="new">
          <svg className="ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="ring-track" cx="8" cy="8" r={RING_R} />
            <path className="ring-plus" d="M8 5.4v5.2M5.4 8h5.2" />
          </svg>
          <span className="sr-only">New session, not started</span>
        </span>
      )
    }

    const ready = context?.ready === true
    const bypass = permissionMode === 'bypassPermissions'

    return (
      <span
        className="tab-indicator"
        data-status={status}
        data-mode={bypass ? 'bypass' : undefined}
      >
        <ContextRing
          used={context?.contextTokens ?? 0}
          limit={context?.contextLimit ?? 0}
          ready={ready}
        />
        {watched && <span className="tab-watch" aria-hidden="true" />}
        <span className="sr-only">
          {watched ? 'Worklog is watching this session. ' : ''}
          {status === 'exited' ? 'Session ended. ' : ''}
          {bypass ? 'Permissions bypassed.' : ''}
        </span>
      </span>
    )
  }
  ```

- [ ] **Step 4: Render it from the tab strip.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`:
  - add `import { TabIndicator } from './TabIndicator'` after the `UsageChip` import, and delete
    `import { ContextRing } from './ContextMeter'` (line 2);
  - replace the whole conditional at lines 103–112 —

  ```tsx
              {ctx?.ready ? (
                <ContextRing used={ctx.contextTokens} limit={ctx.contextLimit} />
              ) : (
                <span
                  className="tab-dot"
                  data-state={
                    tab.status === 'exited' ? 'exited' : bypass ? 'bypass' : 'running'
                  }
                />
              )}
  ```

  — with:

  ```tsx
              <TabIndicator
                kind={tab.kind}
                context={ctx}
                status={tab.status}
                permissionMode={tab.permissionMode}
                watched={false}
              />
  ```

  and delete the now-unused `const bypass = tab.permissionMode === 'bypassPermissions'` at line 83.
  `watched={false}` is wired to the real signal in Task 85.

- [ ] **Step 5: Style the slot, and delete the dot.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, delete the four `.tab-dot`
  rules (currently lines 375–393) and put this in their place:

  ```css
  /*
   * One fixed slot for whatever a tab has to say about its session.
   *
   * Fixed, because a 7px dot used to be swapped for a 14px ring the instant the
   * context watcher reported, and the label and the close button jumped 7px
   * sideways with it. Both children sit in the same grid cell, so the ring, the
   * empty circle and the ring-plus-dot are all exactly --tab-indicator wide.
   */
  .tab-indicator {
    position: relative;
    display: grid;
    place-items: center;
    width: var(--tab-indicator);
    height: var(--tab-indicator);
    flex: none;
  }

  .tab-indicator > .ring,
  .tab-indicator > .tab-watch {
    grid-area: 1 / 1;
  }

  /* The only red in the tab strip, and it means one thing: the worklog agent is
     watching this session. */
  .tab-watch {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: var(--r-full);
    background: var(--tab-dot-worklog);
  }

  /* No reading yet — a plain circle, so the slot is never blank. */
  .ring[data-level='empty'] .ring-track {
    stroke: var(--border-strong);
  }

  /* A New Project tab has no session to measure. */
  .ring-plus {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  /* A finished process reads as absent rather than as an alert. */
  .tab-indicator[data-status='exited'] {
    opacity: 0.45;
  }
  ```

- [ ] **Step 6: Rebuild and prove the label no longer moves.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload the renderer, open a fresh session, and run the Step 1 command **immediately**:
  Expected: `31`.
  Wait three seconds and run it again.
  Expected: `31` — identical. The label does not move when the reading arrives.

- [ ] **Step 7: Prove the slot is 14px in both states.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const s = document.querySelector('.tab-indicator').getBoundingClientRect(); return { w: +s.width.toFixed(2), h: +s.height.toFixed(2), mid: +(s.top + s.height / 2).toFixed(2) } })()"
  ```
  Expected: `{"w":14,"h":14,"mid":21.5}`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/components/TabIndicator.tsx src/renderer/src/components/ContextMeter.tsx src/renderer/src/components/TitleBar.tsx src/renderer/src/styles/app.css && \
    git commit -m "Give the tab indicator one fixed slot, so a reading never shoves the label

The strip rendered a 7px dot until the context watcher became ready and then
swapped in a 14px ring, so the label and the close button jumped 7px sideways
with no transition — and the permission and exit states disappeared along with
the dot, because the ring replaced the whole element rather than filling it. The
ring is now always drawn, empty when there is nothing to report, inside a slot
that is 14px wide in every state."
  ```

---

### Task 84: Make red mean exactly one thing in the tab strip

Red currently means three unrelated things: bypass permission mode (`app.css:387`), a ≥90% context
ring (`app.css:899`), and the close button's hover fill (`app.css:370`). On this machine
`defaults.permissionMode` is `bypassPermissions`, so every tab is red all the time and it reads as
an alert when it is only a mode. Task 83 already deleted the bypass dot; this reassigns the two
remaining meanings so the colour is free for the worklog signal.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the
  `.ring[data-level='critical']` rule, currently at line 899; the `.tab-indicator` block from
  Task 83)
- Test: `scripts/cdp-eval.mjs` computed-stroke measurements.

**Interfaces:**
- Consumes: `--ring-full`, `--warning` (contracts Task 4).
- Produces: nothing new. A CSS-only change.

- [ ] **Step 1: Measure what is red today, and watch it fail.**
  With a session tab open whose permission mode is bypass:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const s = getComputedStyle(document.documentElement); const red = s.getPropertyValue('--danger').trim(); const track = getComputedStyle(document.querySelector('.tab-indicator .ring-track')).stroke; return { danger: red, bypassTrack: track, critical: [...document.styleSheets].flatMap((ss) => { try { return [...ss.cssRules] } catch { return [] } }).filter((r) => r.selectorText && r.selectorText.includes(\"data-level='critical'\")).map((r) => r.style.stroke) } })()"
  ```
  Expected: `critical` contains `var(--danger)`, and `bypassTrack` is the neutral
  `--border-strong` colour — bypass has no treatment at all since Task 83 removed the dot.

- [ ] **Step 2: Give bypass its own treatment.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, append to the
  `.tab-indicator` block added in Task 83:

  ```css
  /*
   * Bypass mode used to own --danger, which put a red dot on every tab on a
   * machine whose default permission mode is bypassPermissions — an alert that
   * was only ever a setting. A dashed warning-coloured track says "the guard
   * rails are off" and cannot be mistaken for the context fill, which is always
   * a solid arc starting at the top.
   */
  .tab-indicator[data-mode='bypass'] .ring-track {
    stroke: var(--warning);
    stroke-dasharray: 1.6 1.6;
  }
  ```

- [ ] **Step 3: Take red off the nearly-full ring.**
  In the same file, replace:

  ```css
  .ring[data-level='critical'] .ring-fill {
    stroke: var(--danger);
  }
  ```

  with:

  ```css
  /*
   * Not --danger. Red in the tab strip now means one thing only — the worklog is
   * watching this session — and a ring cannot be allowed to say it by accident.
   * At 90% the arc is nearly a closed circle, so the shape already carries the
   * urgency the colour used to.
   */
  .ring[data-level='critical'] .ring-fill {
    stroke: var(--ring-full);
  }
  ```

- [ ] **Step 4: Rebuild and prove red is gone from both.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, open a bypass session, then:
  ```bash
  node scripts/cdp-eval.mjs "(() => { const root = getComputedStyle(document.documentElement); const t = getComputedStyle(document.querySelector('.tab-indicator .ring-track')); return { warning: root.getPropertyValue('--warning').trim(), trackStroke: t.stroke, dash: t.strokeDasharray } })()"
  ```
  Expected: `trackStroke` equals the resolved `--warning` colour and `dash` is `"1.6px 1.6px"`.

- [ ] **Step 5: Prove no `--danger` remains in the strip except the close button's hover.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n -- "--danger" src/renderer/src/styles/app.css
  ```
  Inspect each hit. In the tab strip the only permitted survivor is `.tab-close:hover`, which is a
  hover affordance and not a state. `.tab-dot[data-state='bypass']` and
  `.ring[data-level='critical']` must both be gone.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Free red in the tab strip, so it can mean one thing

Red meant bypass mode, a ≥90% context ring and a close-button hover all at once,
and on a machine whose default permission mode is bypassPermissions that put a
red dot on every tab permanently — an alert that was only ever a setting. Bypass
now gets a dashed warning track and the nearly-full ring gets --ring-full, which
leaves red for the worklog watch dot alone."
  ```

---

### Task 85: Draw the worklog watch dot from the real signal

The red dot inside the ring means the worklog agent is watching this session. Workstream C computes
the signal; this consumes it. Per contracts §0.3 the dot is drawn when, and only when, that tab's
`sessionId` has a `WorklogWatchState` with `watched === true`.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/shared/api.ts` (the `worklog` block, lines
  219–233) — **only if workstream C has not already added the two members**
- Modify: `/Users/thevinh/dev/personal/stoke/src/preload/index.ts` (the `worklog` block, lines
  128–135) — same condition
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (bootstrap effect at
  130–181; the `<TitleBar>` element at 665–683)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (Props,
  the tab map)
- Test: `scripts/cdp-eval.mjs`, against a session in a watched group.

**Interfaces:**
- Consumes: `WorklogWatchState` from `@shared/types`, `CH.worklogWatch` / `CH.worklogWatchChanged`
  from `@shared/ipc` (contracts Task 2), and the main-process handlers for both (workstream C).
- Produces:
  ```ts
  // TitleBar Props gains:
  /** Session ids the worklog agent is watching. Drives the red dot in the ring. */
  watchedSessions: Set<string>
  ```

- [ ] **Step 1: Check whether the API surface is already there.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && grep -n "onWatchChanged\|worklogWatch" src/shared/api.ts src/preload/index.ts src/shared/ipc.ts
  ```
  If `src/shared/ipc.ts` has no `worklogWatch`, stop — contracts Task 2 has not landed.
  If `api.ts` and `preload/index.ts` already list `watch` and `onWatchChanged`, skip Step 2.

- [ ] **Step 2: Add the two members if they are missing.**
  In `/Users/thevinh/dev/personal/stoke/src/shared/api.ts`, add `WorklogWatchState` to the type
  import from `./types`, and add to the `worklog` block after `onProposed`:

  ```ts
      /** Which sessions the agent may look at, and why. See WorklogWatchState. */
      watch(): Promise<WorklogWatchState[]>
      onWatchChanged(cb: (states: WorklogWatchState[]) => void): () => void
  ```

  In `/Users/thevinh/dev/personal/stoke/src/preload/index.ts`, add to the `worklog` object after
  `onProposed`:

  ```ts
      watch: () => ipcRenderer.invoke(CH.worklogWatch),
      onWatchChanged: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogWatchChanged, cb)
  ```

  These are the exact lines contracts §0.3 specifies; if workstream C lands them too the edit is
  identical and the conflict resolves to one copy.

- [ ] **Step 3: Hold the watch states in App, and watch the strip stay dotless.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`:
  - add `WorklogWatchState` to the `@shared/types` type import;
  - add beside the other worklog state (after `const [asked, setAsked] = ...`, line 92):

  ```tsx
    /*
     * Which sessions the worklog agent is allowed to look at, pushed whole on
     * every change rather than as a delta — the same rule the proposal queue
     * follows, and for the same reason: two copies of the same records drift.
     * This is the sole input to the red dot in the tab strip.
     */
    const [watchStates, setWatchStates] = useState<WorklogWatchState[]>([])
  ```

  - inside the bootstrap effect, next to `const offWorklog = ...` (line 139):

  ```tsx
      const offWatch = window.stoke.worklog.onWatchChanged(setWatchStates)
      void window.stoke.worklog.watch().then(setWatchStates)
  ```

  - add `offWatch()` to the cleanup return alongside `offWorklog()`;
  - add, next to the other derived values (after the `promptQueue` memo, line 399):

  ```tsx
    const watchedSessions = useMemo(
      () => new Set(watchStates.filter((s) => s.watched).map((s) => s.sessionId)),
      [watchStates]
    )
  ```

  - pass it down: add `watchedSessions={watchedSessions}` to the `<TitleBar>` element.

- [ ] **Step 4: Draw it.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`:
  - add to `Props`, after `contexts`:

  ```ts
    /** Session ids the worklog agent is watching. Drives the red dot in the ring. */
    watchedSessions: Set<string>
  ```

  - add `watchedSessions` to the destructured parameter list;
  - change `watched={false}` on `<TabIndicator>` to `watched={watchedSessions.has(tab.sessionId)}`.

- [ ] **Step 5: Rebuild and prove the dot follows the signal.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, and with **no** group watched (Settings → worklog groups empty) open a session:
  ```bash
  node scripts/cdp-eval.mjs "({ dots: document.querySelectorAll('.tab-watch').length, tabs: document.querySelectorAll('.tablist .tab').length })"
  ```
  Expected: `{"dots":0,"tabs":1}`.
  Now add that session's project group to the watched list in Settings and re-run.
  Expected: `{"dots":1,"tabs":1}` — the settings write is one of the four triggers that fires
  `worklog:watchChanged` (contracts §0.3), so no reload is needed.

- [ ] **Step 6: Prove the dot did not change the slot.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const s = document.querySelector('.tab-indicator').getBoundingClientRect(); const l = document.querySelector('.tab-label').getBoundingClientRect(); const t = document.querySelector('.tab').getBoundingClientRect(); return { w: +s.width.toFixed(2), label: +(l.left - t.left).toFixed(2) } })()"
  ```
  Expected: `{"w":14,"label":31}` — the same numbers as Task 83 Steps 6 and 7.

- [ ] **Step 7: Typecheck and commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && \
    git add src/shared/api.ts src/preload/index.ts src/renderer/src/App.tsx src/renderer/src/components/TitleBar.tsx && \
    git commit -m "Mark watched sessions in the tab strip, from the gate's own predicate

Nothing in the UI ever said which sessions the worklog agent was allowed to look
at, so 'working but with nothing to report' and 'never armed' looked identical.
The dot reads the same WorklogWatchState the paid scan reads, so the mark in the
strip and the run that costs money cannot disagree."
  ```

---

### Task 86: Keep `permissionMode` live instead of frozen at launch

`tab.permissionMode` is captured when the session starts and no `setTabs` writer in `App.tsx`
(lines 271, 283, 335, 421, 480) ever updates it, so toggling with Shift+Tab inside the session
leaves the indicator stating a mode that stopped being true. The transcript records
`{"type":"permission-mode","permissionMode":"…"}` lines and the watcher already parses the
transcript, so this costs no new polling.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/sessionFile.ts` (the `ParsedSession`
  interface at 21–34, the `parseSession` loop at 103–164)
- Modify: `/Users/thevinh/dev/personal/stoke/src/main/context.ts` (the `publish` call at 163–176)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the title-adoption effect
  at 281–295)
- Test: `/Users/thevinh/dev/personal/stoke/scripts/verify-context.mts` (extended)

**Interfaces:**
- Consumes: `ContextSnapshot.permissionMode` from `@shared/types` (contracts Task 2, currently
  hardcoded `null`).
- Produces:
  ```ts
  // src/main/sessionFile.ts — ParsedSession gains:
  /** Newest `permission-mode` record in the transcript, or null when none. */
  permissionMode: PermissionMode | null
  ```

- [ ] **Step 1: Extend the context suite, and watch it fail.**
  In `/Users/thevinh/dev/personal/stoke/scripts/verify-context.mts`, extend the existing
  `node:fs/promises` import at line 7 to `import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'`
  and the existing `node:os` import at line 8 to `import { homedir, tmpdir } from 'node:os'`
  (`join` is already imported from `node:path` at line 9), then insert this block immediately
  **before** the file's last two lines, which are:

  ```ts
  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`}`)
  process.exit(failures.length === 0 ? 0 : 1)
  ```

  ```ts
  /* ------------------------------------------------------------------------
     The permission mode a session is actually in.
     It is captured in the tab at launch and Shift+Tab inside the session never
     reached it, so a tab could claim `bypass` for a session that had been put
     back into `default` half an hour earlier. The transcript is the only place
     that knows, and the watcher already reads it.
     ------------------------------------------------------------------------ */

  const fixtureDir = await mkdtemp(join(tmpdir(), 'stoke-permission-'))
  const withModes = join(fixtureDir, 'with-modes.jsonl')
  const withoutModes = join(fixtureDir, 'without-modes.jsonl')

  await writeFile(
    withModes,
    [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'x' }),
      JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: '/tmp' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'nonsense', sessionId: 'x' }),
      ''
    ].join('\n')
  )
  await writeFile(
    withoutModes,
    [JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: '/tmp' }), ''].join('\n')
  )

  const modes = await parseSession(withModes)
  const noModes = await parseSession(withoutModes)

  check(
    'the newest permission-mode record wins',
    modes.permissionMode === 'bypassPermissions',
    String(modes.permissionMode)
  )
  check(
    'a value that is not a permission mode is ignored rather than adopted',
    modes.permissionMode !== 'nonsense',
    String(modes.permissionMode)
  )
  check(
    'a transcript with no permission-mode record reports null, not a guess',
    noModes.permissionMode === null,
    String(noModes.permissionMode)
  )

  await rm(fixtureDir, { recursive: true, force: true })
  ```

- [ ] **Step 2: Run it and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-context.mts
  ```
  Expected, near the end of the output:
  ```
  FAIL  the newest permission-mode record wins  undefined
  FAIL  a transcript with no permission-mode record reports null, not a guess  undefined
  ```
  and a final line `2 FAILED: the newest permission-mode record wins, a transcript with no permission-mode record reports null, not a guess`.
  (`a value that is not a permission mode is ignored` passes vacuously while the field is
  `undefined`; it starts meaning something once Step 3 lands.)

- [ ] **Step 3: Parse the record.**
  In `/Users/thevinh/dev/personal/stoke/src/main/sessionFile.ts`:
  - add at the top, after the `node:fs/promises` import:

  ```ts
  import type { PermissionMode } from '@shared/types'
  ```

  (type-only, so node's strip-only mode erases it and the verify suite still runs);
  - add to the `ParsedSession` interface, after `model`:

  ```ts
    /** Newest `permission-mode` record in the transcript, or null when none. */
    permissionMode: PermissionMode | null
  ```

  - add above `parseSession`:

  ```ts
  /*
   * Only these five. A transcript is somebody else's file and a mode this app
   * does not understand must not reach the UI as a state nobody can style.
   */
  const PERMISSION_MODES = new Set<string>([
    'default',
    'plan',
    'acceptEdits',
    'auto',
    'bypassPermissions'
  ])
  ```

  - add `permissionMode: null,` to the `out` literal inside `parseSession`, after `model: null,`;
  - add this branch inside the line loop, immediately after the `if (type === 'ai-title') { … }`
    block:

  ```ts
      if (type === 'permission-mode') {
        // Later records win: the mode is toggled with Shift+Tab mid-session and
        // every toggle appends another record.
        const m = rec.permissionMode
        if (typeof m === 'string' && PERMISSION_MODES.has(m)) {
          out.permissionMode = m as PermissionMode
        }
        continue
      }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-context.mts
  ```
  Expected: `ALL CHECKS PASSED`.

- [ ] **Step 5: Put it on the snapshot.**
  In `/Users/thevinh/dev/personal/stoke/src/main/context.ts`, in the `this.publish({ … })` call
  inside `tick`, change `permissionMode: null` to `permissionMode: parsed.permissionMode`.
  Leave `emptySnapshot` at `permissionMode: null` — a session with no file yet has no recorded mode
  and inventing one is what this task exists to stop.

- [ ] **Step 6: Adopt it in the tab.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace the title-adoption effect
  (lines 281–295) with:

  ```tsx
    /*
     * Adopt Claude's own generated title, and keep the permission mode live.
     *
     * Both are read out of the transcript because it is the only thing that
     * knows. `tab.permissionMode` was captured at launch and no writer ever
     * updated it, so a tab kept claiming `bypass` for a session that had been
     * put back into `default` with Shift+Tab — the indicator could simply lie.
     */
    useEffect(() => {
      setTabs((list) => {
        let changed = false
        const next = list.map((t) => {
          const snap = contexts[t.sessionId]
          if (!snap) return t
          const title = snap.title && snap.title !== t.title ? snap.title : null
          const mode =
            snap.permissionMode && snap.permissionMode !== t.permissionMode
              ? snap.permissionMode
              : null
          if (!title && !mode) return t
          changed = true
          return {
            ...t,
            ...(title ? { title } : {}),
            ...(mode ? { permissionMode: mode } : {})
          }
        })
        return changed ? next : list
      })
    }, [contexts])
  ```

- [ ] **Step 7: Rebuild and watch the indicator follow a live toggle.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, start a session in `default` mode, and confirm:
  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.tab-indicator').dataset.mode ?? null"
  ```
  Expected: `null`.
  Press **Shift+Tab** inside the terminal until Claude Code reports bypass mode, wait two seconds
  for the watcher's poll, and re-run.
  Expected: `"bypass"`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/main/sessionFile.ts src/main/context.ts src/renderer/src/App.tsx scripts/verify-context.mts && \
    git commit -m "Read the permission mode from the transcript, so the tab cannot lie about it

tab.permissionMode was captured at launch and no setTabs writer ever updated it,
so toggling with Shift+Tab left the indicator stating a mode that had stopped
being true — the one failure mode an indicator must not have. The transcript
records every toggle and the context watcher already parses it, so this costs no
new polling. Only the five known modes are adopted; anything else is ignored."
  ```

---

### Task 87: Stop `role="tablist"` containing things that are not tabs

`TitleBar.tsx:80` wraps the `+` button inside the tablist and `BrowserPanel.tsx:106` wraps six
non-tab children in one. A screen reader announces "tab 3 of 3" for a button that is not a tab, and
arrow-key tab semantics apply to controls that do not answer to them.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (the
  `.tabs` element, lines 80 and 133)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/BrowserPanel.tsx` (the
  `.browser-tabs` element, lines 106 and 187)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the `.tabs` rule at
  264–281; the `.browser-tabs` rule)
- Test: `scripts/cdp-eval.mjs` role-child audit; geometry re-measure.

**Interfaces:**
- Consumes: `--space-4` (contracts Task 4).
- Produces: two new class names, `.tablist` and `.btablist`, which are layout-only.

- [ ] **Step 1: Audit the tablists, and watch them fail.**
  Open the docked browser first (Ctrl/Cmd+B) so both strips exist, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "[...document.querySelectorAll('[role=\"tablist\"]')].map((l) => ({ label: l.getAttribute('aria-label'), nonTabChildren: [...l.children].filter((c) => c.getAttribute('role') !== 'tab').length }))"
  ```
  Expected: `[{"label":"Sessions","nonTabChildren":1},{"label":"Browser tabs","nonTabChildren":6}]`.

- [ ] **Step 2: Record the strip geometry that must not change.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(2) }; const t = document.querySelector('.tab').getBoundingClientRect(); return { tabTop: +t.top.toFixed(2), tabBottom: +t.bottom.toFixed(2), plus: mid(document.querySelector('.tabs > .icon-btn')) } })()"
  ```
  Expected: `{"tabTop":4,"tabBottom":43,"plus":21.5}`.

- [ ] **Step 3: Move the role onto a wrapper in the title bar.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`, change line 80
  from:

  ```tsx
        <div className="tabs" role="tablist" aria-label="Sessions">
  ```

  to:

  ```tsx
        {/*
          The strip and the tablist are two different things. The + button lives
          in the strip and is emphatically not a tab: inside the tablist a screen
          reader announced it as one, and arrow-key tab semantics applied to a
          control that does not answer to them.
        */}
        <div className="tabs">
          <div className="tablist" role="tablist" aria-label="Sessions">
  ```

  and close the new wrapper by replacing the `+` button block (lines 129–132) with:

  ```tsx
          </div>

          <button className="icon-btn" onClick={onNewTab} title="New session (Ctrl/Cmd+T)">
            <IconPlus />
            <span className="sr-only">New session</span>
          </button>
  ```

  Re-indent the tab `map` body one level so the JSX stays balanced.

- [ ] **Step 4: Do the same in the browser panel.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/BrowserPanel.tsx`, change line
  106 from:

  ```tsx
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
  ```

  to:

  ```tsx
        <div className="browser-tabs">
          {/* Only the tabs. The new-tab button, the spacer and the four page
              actions are controls in the same strip, not tabs in the list. */}
          <div className="btablist" role="tablist" aria-label="Browser tabs">
  ```

  and close the wrapper immediately after the tab `map`, i.e. replace:

  ```tsx
          <button className="icon-btn" onClick={() => window.stoke.browser.newTab()} title="New tab">
  ```

  with:

  ```tsx
          </div>

          <button className="icon-btn" onClick={() => window.stoke.browser.newTab()} title="New tab">
  ```

  Re-indent the `.btab` map body one level.

- [ ] **Step 5: Give both wrappers the layout the strips used to carry.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, replace the `.tabs` rule
  and its scrollbar rule with:

  ```css
  .tabs {
    display: flex;
    align-items: stretch;
    gap: var(--space-4);
    flex: 1;
    min-width: 0;
    height: 100%;
    padding-top: var(--space-4);
  }

  /*
   * The list itself. It carries the overflow so the tabs scroll and the + button
   * beside them stays put, and `min-width: 0` is what lets it shrink instead of
   * pushing the shell wider than the window — see CLAUDE.md gotcha 14, which is
   * about exactly this failure one level up.
   */
  .tablist {
    display: flex;
    align-items: stretch;
    gap: var(--space-4);
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tablist::-webkit-scrollbar {
    display: none;
  }
  ```

  and, in the `.browser-tabs` rule, delete `overflow-x: auto;` and `scrollbar-width: none;`, then
  add after it:

  ```css
  .btablist {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .btablist::-webkit-scrollbar {
    display: none;
  }
  ```

  Finally, keep the `+` button from being squeezed: in the `.tabs > .icon-btn` rule (the one whose
  comment explains the margin-box trap), add `flex: none;` as a new declaration. It had implicit
  `flex-shrink: 1` and only survived because nothing had pushed it yet.

- [ ] **Step 6: Rebuild, re-audit, and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload, open a session and the browser, then re-run the Step 1 command.
  Expected: `[{"label":"Sessions","nonTabChildren":0},{"label":"Browser tabs","nonTabChildren":0}]`.

- [ ] **Step 7: Prove the geometry is unchanged.**
  Re-run the Step 2 command.
  Expected: `{"tabTop":4,"tabBottom":43,"plus":21.5}` — identical.

- [ ] **Step 8: Typecheck and commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && \
    git add src/renderer/src/components/TitleBar.tsx src/renderer/src/components/BrowserPanel.tsx src/renderer/src/styles/app.css && \
    git commit -m "Put only tabs inside the tablists

Both strips wrapped their whole toolbar in role=tablist — the session strip's new
-tab button and six controls in the browser strip — so a screen reader announced
buttons as tabs and arrow-key tab semantics applied to controls that ignore them.
The list is now its own element inside the strip, and it carries the overflow, so
the buttons beside it stay put instead of scrolling away with the tabs."
  ```

---

### Task 88: Closing a tab selects its neighbour, not the last tab

`App.tsx:481` selects `next[next.length - 1]` — close the first of five tabs and focus jumps to the
far end of the strip. Every tabbed application selects the neighbour.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (`closeTab`, lines 473–484)
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts`
- Create: `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts`
- Modify: `/Users/thevinh/dev/personal/stoke/package.json` (scripts)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // src/renderer/src/lib/tabs.ts
  /** Which tab id to select once `closedId` is gone. Null when none is left. */
  export function neighbourOf(ids: string[], closedId: string): string | null
  ```

- [ ] **Step 1: Write the failing suite.**
  Create `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts`:

  ```ts
  /*
   * Tab list arithmetic: which tab is selected when one closes, and where a
   * dragged tab lands. Both are pure list operations that were written inline in
   * a React callback, where the only way to check them was to click.
   *
   *   node scripts/verify-tabs.mts
   */
  import { neighbourOf } from '../src/renderer/src/lib/tabs.ts'

  let failures = 0

  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  const five = ['a', 'b', 'c', 'd', 'e']

  console.log('\nclosing a tab selects its neighbour')
  check('closing the first selects the one that takes its place', neighbourOf(five, 'a'), 'b')
  check('closing a middle one selects the one that takes its place', neighbourOf(five, 'c'), 'd')
  check('closing the last selects the one before it', neighbourOf(five, 'e'), 'd')
  check('closing the only tab leaves nothing selected', neighbourOf(['a'], 'a'), null)
  check('closing a tab that is not there changes nothing', neighbourOf(five, 'zz'), null)
  check('an empty list has no neighbour', neighbourOf([], 'a'), null)

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts'`.

- [ ] **Step 3: Write the rule.**
  Create `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts`:

  ```ts
  /**
   * Which tab id to select once `closedId` is gone, or null when the list empties.
   *
   * The tab that takes the closed one's index, falling back to the one before it.
   * The old rule selected the *last* tab, so closing the first of five threw the
   * user to the far end of the strip — the one place they were not looking.
   */
  export function neighbourOf(ids: string[], closedId: string): string | null {
    const at = ids.indexOf(closedId)
    if (at < 0) return null
    const rest = ids.filter((id) => id !== closedId)
    if (rest.length === 0) return null
    return rest[Math.min(at, rest.length - 1)]
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected: `all pass`.

- [ ] **Step 5: Use it.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add
  `import { neighbourOf } from './lib/tabs'` beside the other `./lib/` imports, and replace line
  481:

  ```tsx
        if (activeTabId === id) setActiveTabId(next.length ? next[next.length - 1].id : null)
  ```

  with:

  ```tsx
        if (activeTabId === id) {
          setActiveTabId(neighbourOf(tabs.map((t) => t.id), id))
        }
  ```

- [ ] **Step 6: Register the suite.**
  In `/Users/thevinh/dev/personal/stoke/package.json`, add after the `verify:worklog-gate` line:

  ```json
      "verify:tabs": "node scripts/verify-tabs.mts",
  ```

  and insert `&& npm run verify:tabs` into the `check` script immediately after
  `npm run verify:worklog-gate`.

- [ ] **Step 7: Rebuild and confirm in the app.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build && npm run verify:tabs
  ```
  Reload, open three sessions, select the first, close it, and:
  ```bash
  node scripts/cdp-eval.mjs "[...document.querySelectorAll('.tab')].findIndex((t) => t.getAttribute('aria-selected') === 'true')"
  ```
  Expected: `0` — the tab that took the closed one's place. Before this change it was `1`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/lib/tabs.ts scripts/verify-tabs.mts package.json src/renderer/src/App.tsx && \
    git commit -m "Select a closed tab's neighbour, not the far end of the strip

closeTab selected next[next.length - 1], so closing the first of five tabs threw
focus to the last one — the single place the user was not looking. The rule is now
a pure function with a suite, because the only previous way to check it was to
click five times and watch."
  ```

---

### Task 89: One session cache, keyed by path

`sessions` and `sessionsLoading` are App-level singletons (`App.tsx:62-63`) refetched whenever
`selectedPath` changes. Several New Project tabs each need their own project selection, and the
contract is explicit that `sessions` must **not** move onto `Tab` — two tabs on one project would
hold two copies that drift. It becomes one cache keyed by path. Pure refactor; no visible change.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (state at 62–63; the
  sessions effect at 246–261; the `<Sidebar>` and `<Launcher>` elements)
- Test: `scripts/cdp-eval.mjs` session-row counts before and after.

**Interfaces:**
- Consumes: `SessionMeta` from `@shared/types`.
- Produces: nothing exported. App-internal state shape changes to
  `sessionsByPath: Record<string, SessionMeta[]>` and `sessionsLoadingPath: string | null`.

- [ ] **Step 1: Record the baseline, so the refactor can be proved invisible.**
  Reload, click a project in the sidebar that has session history, expand it, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ sidebar: document.querySelectorAll('.sessions .session').length, launcher: document.querySelectorAll('.launcher .session').length })"
  ```
  Save the printed JSON. Step 5 must reproduce it exactly.

- [ ] **Step 2: Replace the state.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace lines 62–63:

  ```tsx
    const [sessions, setSessions] = useState<SessionMeta[]>([])
    const [sessionsLoading, setSessionsLoading] = useState(false)
  ```

  with:

  ```tsx
    /*
     * One cache for every project's session list, keyed by path.
     *
     * Deliberately not per-tab: two New Project tabs pointed at the same project
     * would hold two copies of the same fetched list, and the moment one of them
     * refetched they would disagree about the same folder. A cache keyed by the
     * folder cannot do that.
     */
    const [sessionsByPath, setSessionsByPath] = useState<Record<string, SessionMeta[]>>({})
    /** The path currently being fetched, or null. Drives the loading state. */
    const [sessionsLoadingPath, setSessionsLoadingPath] = useState<string | null>(null)
  ```

- [ ] **Step 3: Replace the fetch effect and derive the two old values.**
  Replace the effect at lines 246–261:

  ```tsx
    useEffect(() => {
      if (!selectedPath) {
        setSessions([])
        return
      }
      let cancelled = false
      setSessionsLoading(true)
      void window.stoke.projects.sessions(selectedPath).then((list) => {
        if (cancelled) return
        setSessions(list)
        setSessionsLoading(false)
      })
      return () => {
        cancelled = true
      }
    }, [selectedPath])
  ```

  with:

  ```tsx
    useEffect(() => {
      const path = selectedPath
      if (!path) return
      let cancelled = false
      setSessionsLoadingPath(path)
      void window.stoke.projects.sessions(path).then((list) => {
        if (cancelled) return
        setSessionsByPath((prev) => ({ ...prev, [path]: list }))
        setSessionsLoadingPath((cur) => (cur === path ? null : cur))
      })
      return () => {
        cancelled = true
      }
    }, [selectedPath])

    /*
     * What the sidebar and the launcher read. A cached list is shown immediately
     * on the way back to a project already visited, and the spinner only appears
     * for a folder nothing is known about yet.
     */
    const sessions = selectedPath ? (sessionsByPath[selectedPath] ?? []) : []
    const sessionsLoading = selectedPath !== null && sessionsLoadingPath === selectedPath
  ```

  Nothing at the `<Sidebar>` or `<Launcher>` call sites changes: both still receive `sessions` and
  `sessionsLoading` by those names.

- [ ] **Step 4: Typecheck and rebuild.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Expected: exit 0 from both.

- [ ] **Step 5: Reproduce the baseline exactly.**
  Reload, click the same project, expand it, and re-run the Step 1 command.
  Expected: byte-identical to the saved JSON.

- [ ] **Step 6: Prove a revisit is instant.**
  Click project A, then project B, then A again, and immediately (within the same second):
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ rows: document.querySelectorAll('.sessions .session').length, loading: [...document.querySelectorAll('.sessions .session-meta')].some((n) => n.textContent.startsWith('Loading')) })"
  ```
  Expected: `rows` is the same non-zero count A had. The cached list renders before the refetch
  resolves, so there is no empty frame in between — that is the whole point of the cache.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/App.tsx && \
    git commit -m "Cache session lists by project path, ready for several launcher tabs

A single App-level sessions array cannot serve two New Project tabs pointed at
different projects, and putting the array on the tab would let two tabs on the
same project hold copies that drift. Keying the cache on the folder makes both
problems structurally impossible, and it makes returning to a project instant."
  ```

---

### Task 90: Make the New Project state a real tab

`App.tsx:675` does `onNewTab={() => setActiveTabId(null)}`: it clears the selection and appends
nothing, so "new session" has no representation in the strip at all. The Launcher is already the New
Project tab's content — it just is not a tab. This makes it one, so `activeTabId === null` stops
being a state the app has to model.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (imports; bootstrap effect
  130–181; exit-attach effect 266–279; `startSession` 297–342; `startHostSession` 408–443;
  `closeTab` 473–484; `restartTab` 486–492; `askClaude` 535–550; the render at 663–899)
- Create: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/newTab.ts`
- Test: `scripts/cdp-eval.mjs` tab-count and pane-visibility measurements.

**Interfaces:**
- Consumes: `Tab`, `TabKind` from `/Users/thevinh/dev/personal/stoke/src/renderer/src/types.ts`
  (contracts Task 2 / §0.7 — `kind`, `hostId`, `selectedPath`, `expandedPath` already exist).
- Produces:
  ```ts
  // src/renderer/src/lib/newTab.ts
  /** A New Project tab: a strip entry with no process behind it. */
  export function newTab(selectedPath?: string | null, expandedPath?: string | null): Tab
  ```
  and `startSession` gains an option:
  ```ts
  /** Replace this tab in place instead of appending. Used to consume a New tab. */
  replaceTabId?: string
  ```

- [ ] **Step 1: Measure the missing tab, and watch it fail.**
  Reload with no sessions running:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, launcher: !!document.querySelector('.launcher') })"
  ```
  Expected: `{"tabs":0,"launcher":true}` — the launcher is on screen and the strip is empty.

- [ ] **Step 2: Write the factory.**
  Create `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/newTab.ts`:

  ```ts
  import type { Tab } from '../types'

  /**
   * A New Project tab: a strip entry with no process behind it.
   *
   * The launcher was always this tab's content; it just was not a tab, so the
   * "about to start something" state had no place in the strip and `+` could
   * only clear the selection. Everything a session tab needs and this one has no
   * answer for is an empty string, never a fake — `ptyId` and `sessionId` are
   * empty because there is no process and no transcript, and `status` reads
   * `running` only because a tab with no process cannot have exited. Nothing
   * reads `status` for a `new` tab; the indicator branches on `kind` first.
   */
  export function newTab(
    selectedPath: string | null = null,
    expandedPath: string | null = null
  ): Tab {
    return {
      id: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'new',
      ptyId: '',
      sessionId: '',
      cwd: '',
      projectName: '',
      title: 'New session',
      permissionMode: 'default',
      model: '',
      effort: 'default',
      status: 'running',
      exitCode: null,
      hostId: null,
      selectedPath,
      expandedPath
    }
  }
  ```

- [ ] **Step 3: Seed one at boot, so `activeTabId` is never null.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`:
  - add `import { newTab } from './lib/newTab'` beside the other `./lib/` imports;
  - change the tab state initialiser at line 65–66 from:

  ```tsx
    const [tabs, setTabs] = useState<Tab[]>([])
    const [activeTabId, setActiveTabId] = useState<string | null>(null)
  ```

  to:

  ```tsx
    /*
     * The app always has at least one tab. A New Project tab is a real tab now,
     * so `activeTabId === null` — which used to mean "showing the launcher" —
     * is not a state the app can be in, and every reader that special-cased it
     * is gone.
     */
    const [tabs, setTabs] = useState<Tab[]>(() => [newTab()])
    const [activeTabId, setActiveTabId] = useState<string | null>(null)

    /*
     * Select the first tab as soon as it exists. `cur ?? …` makes this inert
     * after the first pass: it can never replace a real selection, so it is safe
     * to depend on the whole tab list.
     */
    useEffect(() => {
      setActiveTabId((cur) => cur ?? tabs[0]?.id ?? null)
    }, [tabs])
  ```

- [ ] **Step 4: Let a launch consume the New tab it was launched from.**
  In `startSession` (lines 297–342), add `replaceTabId?: string` to the options type, add
  `kind: 'session' as const, hostId: null, selectedPath: null, expandedPath: null` to the `tab`
  literal, and replace `setTabs((list) => [...list, tab])` with:

  ```tsx
          /*
           * A session started from a New Project tab takes that tab's place
           * rather than appending beside it. Appending would leave the launcher
           * sitting next to the terminal it just started, which reads as the
           * button having failed.
           */
          setTabs((list) => {
            const at = opts.replaceTabId ? list.findIndex((t) => t.id === opts.replaceTabId) : -1
            if (at < 0) return [...list, tab]
            const next = [...list]
            next[at] = tab
            return next
          })
  ```

  Add, just above `startSession`:

  ```tsx
    /** The New Project tab a launch should consume, or null to append. */
    const activeNewTabId = useMemo(() => {
      const t = tabs.find((x) => x.id === activeTabId)
      return t && t.kind === 'new' ? t.id : null
    }, [tabs, activeTabId])
  ```

  and pass `replaceTabId: activeNewTabId ?? undefined` from every launcher-initiated call:
  `startDefault`, `startScratch`, `resumeSession`, and both `startSession` calls inside the
  `<Launcher>` element's `onStart` / `onContinueLast`. Add `activeNewTabId` to each of those
  callbacks' dependency arrays. Do the same in `startHostSession`, whose `setTabs` becomes the same
  replace-or-append shape and whose tab literal gains `kind: 'session' as const`,
  `hostId: host.id`, `selectedPath: null`, `expandedPath: null`.

  Leave `Sidebar`'s `onStartNew` appending (no `replaceTabId`) — starting a session from the sidebar
  while a terminal is open must not eat the launcher tab the user left open.

- [ ] **Step 5: Stop the process-shaped code touching processless tabs.**
  In the same file:
  - the exit-attach effect (266–279): change `.filter((t) => t.status === 'running')` to
    `.filter((t) => t.kind === 'session' && t.status === 'running')`;
  - `closeTab` (473–484): guard the kill —

  ```tsx
        if (tab.kind === 'session') {
          window.stoke.pty.kill(tab.ptyId)
          forgetPty(tab.ptyId)
        }
        // Never leave the strip empty: closing the last tab lands on a fresh New
        // Project tab, which is where the app starts anyway.
        const next = tabs.filter((t) => t.id !== id)
        const replacement = next.length ? next : [newTab()]
        setTabs(replacement)
        if (activeTabId === id) {
          setActiveTabId(
            next.length ? neighbourOf(tabs.map((t) => t.id), id) : replacement[0].id
          )
        }
  ```

  - `askClaude` (535–550): change the target lookup to session tabs only —

  ```tsx
        const live = tabs.filter((t) => t.kind === 'session')
        const target = live.find((t) => t.id === activeTabId) ?? live[live.length - 1]
  ```

- [ ] **Step 6: Render the launcher as the active New tab's content.**
  Replace the `.term-stack` block and the `{activeTabId === null && (<Launcher … />)}` block
  (lines 769–820) so the stack is gated on the active tab's kind and the launcher is keyed to the
  tab it belongs to:

  ```tsx
            <div
              className="term-stack"
              style={{ display: activeTab?.kind === 'session' ? 'block' : 'none' }}
            >
              {tabs
                .filter((tab) => tab.kind === 'session')
                .map((tab) => (
                  <TerminalView
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    theme={theme}
                    fontFamily={settings?.fontFamily ?? 'monospace'}
                    fontSize={settings?.fontSize ?? 13}
                    onOpenUrl={openUrl}
                    onRestart={restartTab}
                    onClose={closeTab}
                  />
                ))}
            </div>

            {/*
              Only the active New Project tab renders. The launcher holds no state
              of its own — its selection lives on the tab — so keying it on the
              tab id remounts it when you switch between two New tabs, which is
              also what re-focuses the primary action.
            */}
            {activeTab?.kind === 'new' && (
              <Launcher
                key={activeTab.id}
                project={selectedProject}
                defaultCwd={defaultCwd}
                permissionMode={mode}
                model={model}
                effort={effort}
                ultracode={ultracode}
                sessions={sessions}
                cli={cli}
                onChangeMode={changeMode}
                onChangeModel={changeModel}
                onChangeEffort={changeEffort}
                onChangeUltracode={changeUltracode}
                onStart={() => {
                  if (selectedProject) {
                    void startSession({
                      cwd: selectedProject.path,
                      name: selectedProject.name,
                      replaceTabId: activeNewTabId ?? undefined
                    })
                  }
                }}
                onContinueLast={() => {
                  if (selectedProject) {
                    void startSession({
                      cwd: selectedProject.path,
                      name: selectedProject.name,
                      continueLast: true,
                      replaceTabId: activeNewTabId ?? undefined
                    })
                  }
                }}
                onResume={resumeSession}
                onOpenFolder={() => void openFolder()}
                onStartDefault={startDefault}
                hosts={settings?.hosts ?? []}
                onConnectHost={(h) => void startHostSession(h)}
                onStartScratch={() => void startScratch()}
              />
            )}
  ```

  `activeTab` is already computed at line 554 and `activeNewTabId` was added in Step 4; both are
  `const`s in the same function body, so both are in scope at the JSX.

- [ ] **Step 7: Typecheck, rebuild, and watch the tab appear.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload with no sessions running and re-run the Step 1 command.
  Expected: `{"tabs":1,"launcher":true}` — the launcher is now *in* a tab.
  Then confirm its indicator:
  ```bash
  node scripts/cdp-eval.mjs "({ kind: document.querySelector('.tab-indicator').dataset.kind, label: document.querySelector('.tab-label').textContent })"
  ```
  Expected: `{"kind":"new","label":"New session"}`.

- [ ] **Step 8: Confirm a launch consumes the tab rather than appending.**
  Press **Start here** in the launcher, wait for the terminal, then:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, newTabs: document.querySelectorAll('.tab-indicator[data-kind=\"new\"]').length, term: getComputedStyle(document.querySelector('.term-stack')).display })"
  ```
  Expected: `{"tabs":1,"newTabs":0,"term":"block"}` — one tab, and it is the session.

- [ ] **Step 9: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/lib/newTab.ts src/renderer/src/App.tsx && \
    git commit -m "Make the New Project state a real tab

The launcher was already this tab's content and simply was not a tab, so the app
modelled 'about to start something' as activeTabId === null and the strip showed
nothing at all. With a real tab the null state disappears, closing the last tab
lands on a fresh one instead of on an empty window, and a launch consumes the tab
it was started from rather than leaving a launcher sitting beside its terminal."
  ```

---

### Task 91: Give each New Project tab its own launcher selection

`selectedPath` and `expandedPath` are App-level (`App.tsx:60-61`), so two New Project tabs would
both point at whatever was clicked last. The contract puts both on `Tab`. The sidebar keeps a
single visible selection — it is one list and can only highlight one row — but each New tab
remembers its own target, so switching between them restores what each was aimed at.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (state at 60–61; the
  `<Sidebar>` element's `onSelectProject` / `onToggleExpand`; the sessions effect; `openFolder`;
  the palette's `onPick`)
- Test: `scripts/cdp-eval.mjs` selection round-trip across two New tabs.

**Interfaces:**
- Consumes: `Tab.selectedPath`, `Tab.expandedPath` (contracts §0.7).
- Produces: two App-internal writers,
  ```ts
  const selectProject: (path: string | null) => void
  const toggleExpand: (path: string | null) => void
  ```
  which write the sidebar's visible selection **and** the active New tab's own copy.

- [ ] **Step 1: Measure the shared selection, and watch it fail.**
  This needs two New tabs, which Task 92 has not delivered yet — create the second one from the
  console for this measurement only:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "document.querySelectorAll('.tablist .tab').length"
  ```
  With one New tab open, click project A in the sidebar and record:
  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.launcher-title').textContent"
  ```
  Expected: `"A"`. There is no second tab to compare against yet, which is exactly the gap: the
  selection has nowhere per-tab to live. Step 6 measures the real behaviour once Task 92 lands.

- [ ] **Step 2: Rename the App-level state to what it now is.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, replace lines 60–61:

  ```tsx
    const [selectedPath, setSelectedPath] = useState<string | null>(null)
    const [expandedPath, setExpandedPath] = useState<string | null>(null)
  ```

  with:

  ```tsx
    /*
     * What the sidebar highlights. One list, one highlight — but a New Project
     * tab also keeps its own copy, so two of them aimed at different projects
     * each come back to their own when selected. The sidebar's copy is written
     * alongside the tab's so switching from a New tab to a session tab does not
     * blank the list.
     */
    const [browsePath, setBrowsePath] = useState<string | null>(null)
    const [browseExpanded, setBrowseExpanded] = useState<string | null>(null)
  ```

- [ ] **Step 3: Derive the visible selection and write both copies.**
  Add immediately after `activeNewTabId` (introduced in Task 90):

  ```tsx
    /** The active New tab's own target, or the sidebar's, in that order. */
    const selectedPath = useMemo(() => {
      const t = tabs.find((x) => x.id === activeTabId)
      return t && t.kind === 'new' ? t.selectedPath : browsePath
    }, [tabs, activeTabId, browsePath])

    const expandedPath = useMemo(() => {
      const t = tabs.find((x) => x.id === activeTabId)
      return t && t.kind === 'new' ? t.expandedPath : browseExpanded
    }, [tabs, activeTabId, browseExpanded])

    const selectProject = useCallback(
      (path: string | null): void => {
        setBrowsePath(path)
        setTabs((list) =>
          list.map((t) =>
            t.id === activeTabId && t.kind === 'new' ? { ...t, selectedPath: path } : t
          )
        )
      },
      [activeTabId]
    )

    const toggleExpand = useCallback(
      (path: string | null): void => {
        setBrowseExpanded(path)
        setTabs((list) =>
          list.map((t) =>
            t.id === activeTabId && t.kind === 'new' ? { ...t, expandedPath: path } : t
          )
        )
      },
      [activeTabId]
    )
  ```

  Every existing reader of `selectedPath` / `expandedPath` — the sessions effect, `selectedProject`,
  and the `<Sidebar>` props — keeps working unchanged, because the names are the same.

- [ ] **Step 4: Point every writer at the new functions.**
  In the same file, replace:
  - `<Sidebar>`'s `onSelectProject` (lines 698–701) with
    `onSelectProject={(p) => selectProject(p.path)}` — note the `setActiveTabId(null)` goes with it,
    because `null` is no longer a state (Task 90);
  - `<Sidebar>`'s `onToggleExpand` (lines 702–705) with

  ```tsx
                  onToggleExpand={(p) => {
                    selectProject(p.path)
                    toggleExpand(expandedPath === p.path ? null : p.path)
                  }}
  ```

  - `openFolder`'s body (lines 601–607) — drop `setActiveTabId(null)` and use `selectProject(dir)`;
  - the palette's `onPick` (lines 879–883) — drop `setActiveTabId(null)` and use
    `selectProject(p.path)`.

  Add `selectProject` / `expandedPath` / `toggleExpand` to the dependency arrays of `openFolder`.

- [ ] **Step 5: Typecheck and rebuild.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Expected: exit 0 from both. In particular, `grep -n "setActiveTabId(null)" src/renderer/src/App.tsx`
  must now return nothing.

- [ ] **Step 6: Confirm one selection still works.**
  Reload, click a project in the sidebar, and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ title: document.querySelector('.launcher-title').textContent, current: document.querySelectorAll('.project[aria-current=\"true\"]').length })"
  ```
  Expected: the project's name and `{"current":1}`. The two-tab round trip is measured in Task 92
  Step 6, once there is a way to make a second New tab.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/App.tsx && \
    git commit -m "Give each New Project tab its own launcher target

Two New Project tabs sharing one App-level selectedPath would both point at
whatever was clicked last, which is the whole reason several of them were not
possible. The sidebar keeps one visible highlight, because it is one list, and
each New tab keeps its own copy alongside it. Removing the last setActiveTabId
(null) call sites also stops clicking a project hiding a running terminal."
  ```

---

### Task 92: `+` appends a real New Project tab, and several are allowed

With the tab kind and the per-tab selection in place, `+` can finally do what it says.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (the `<TitleBar>`
  `onNewTab`; the `newTab` shortcut case at 565–567)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (a `.tab` rule for
  the `new` kind)
- Test: `scripts/cdp-eval.mjs` two-tab round trip.

**Interfaces:**
- Consumes: `newTab()` from `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/newTab.ts`
  (Task 90), `selectProject` (Task 91).
- Produces: one App-internal callback,
  ```ts
  /** Append a New Project tab and select it. Several may be open at once. */
  const openNewTab: () => void
  ```

- [ ] **Step 1: Measure what `+` does today, and watch it fail.**
  Reload, start one session so a session tab exists, then press `+` in the title bar and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, launcher: !!document.querySelector('.launcher') })"
  ```
  Expected: `{"tabs":1,"launcher":false}` — nothing was appended and nothing happened, because
  `onNewTab` still points at a callback that only cleared a selection that no longer exists.

- [ ] **Step 2: Write the callback.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, add beside the other tab
  callbacks (just above `closeTab`):

  ```tsx
    /**
     * Append a New Project tab and select it.
     *
     * Several may be open at once, which is the point: each one carries its own
     * project selection, so two launchers can be aimed at two different folders
     * while a third terminal keeps running. It inherits the sidebar's current
     * selection so pressing + does not throw away what is on screen.
     */
    const openNewTab = useCallback((): void => {
      const tab = newTab(browsePath, browseExpanded)
      setTabs((list) => [...list, tab])
      setActiveTabId(tab.id)
    }, [browsePath, browseExpanded])
  ```

- [ ] **Step 3: Wire the button and the shortcut.**
  In the same file:
  - change the `<TitleBar>` prop at line 675 from `onNewTab={() => setActiveTabId(null)}` to
    `onNewTab={openNewTab}`;
  - change the `newTab` shortcut case (lines 565–567) from `setActiveTabId(null)` to `openNewTab()`,
    and add `openNewTab` to that effect's dependency array.

- [ ] **Step 4: Let a New tab read as unstarted in the strip.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add after the `.tab-label`
  rule:

  ```css
  /*
   * A New Project tab has no session behind it, so its label is a placeholder
   * rather than a name. Muting it keeps the strip readable when three of them
   * are open beside two live sessions.
   */
  .tab:has(.tab-indicator[data-kind='new']) .tab-label {
    color: var(--text-muted);
  }
  ```

- [ ] **Step 5: Typecheck, rebuild, and watch `+` work.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload, start one session, press `+` twice, and:
  ```bash
  node scripts/cdp-eval.mjs "({ tabs: document.querySelectorAll('.tablist .tab').length, newTabs: document.querySelectorAll('.tab-indicator[data-kind=\"new\"]').length, launcher: !!document.querySelector('.launcher'), term: getComputedStyle(document.querySelector('.term-stack')).display })"
  ```
  Expected: `{"tabs":3,"newTabs":2,"launcher":true,"term":"none"}`.

- [ ] **Step 6: Prove each New tab remembers its own project (Task 91's deliverable).**
  With the two New tabs from Step 5: select the first, click project **A** in the sidebar; select
  the second, click project **B**; then select the first again and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "new Promise((r) => setTimeout(() => r(document.querySelector('.launcher-title').textContent), 60))"
  ```
  Expected: `"A"` — not `"B"`. Select the second and re-run.
  Expected: `"B"`.

- [ ] **Step 7: Prove a running terminal survives a sidebar click (design §2.10).**
  Select the session tab, then click a project in the sidebar and:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "({ term: getComputedStyle(document.querySelector('.term-stack')).display, selected: document.querySelector('.tab[aria-selected=\"true\"] .tab-label').textContent })"
  ```
  Expected: `term` is `"block"` and the selected tab is still the session's. Before this workstream
  the click set `activeTabId` to null and the terminal vanished.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/App.tsx src/renderer/src/styles/app.css && \
    git commit -m "Make + append a New Project tab, and allow several at once

onNewTab was setActiveTabId(null): it cleared the selection and appended nothing,
so the button appeared to do nothing whenever a session was already open. Each
New tab now carries its own project selection, so two launchers can be aimed at
two folders while a terminal keeps running — and clicking a project in the sidebar
no longer hides that terminal, because there is no null state left to fall into."
  ```

---

### Task 93: Drag to reorder tabs

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts` (add `moveTab`)
- Modify: `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts` (add the cases)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx` (add `reorderTab`; pass it
  down)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx` (drag
  handlers on `.tab`)
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (drag affordances)

**Interfaces:**
- Consumes: `neighbourOf` already in `lib/tabs.ts` (Task 88).
- Produces:
  ```ts
  // src/renderer/src/lib/tabs.ts
  /** `dragId` moved to `overId`'s index. The same list back when either is unknown. */
  export function moveTab<T extends { id: string }>(list: T[], dragId: string, overId: string): T[]

  // TitleBar Props gains:
  /** Reorder: the dragged tab takes the target's index. */
  onReorderTab: (dragId: string, overId: string) => void
  ```

- [ ] **Step 1: Extend the suite, and watch it fail.**
  In `/Users/thevinh/dev/personal/stoke/scripts/verify-tabs.mts`, change the import to
  `import { moveTab, neighbourOf } from '../src/renderer/src/lib/tabs.ts'` and append before the
  final `console.log`:

  ```ts
  console.log('\ndragging a tab onto another')
  const ids = (list: { id: string }[]): string[] => list.map((t) => t.id)
  const five5 = five.map((id) => ({ id }))

  check('dragging right lands on the target index', ids(moveTab(five5, 'a', 'c')), [
    'b',
    'c',
    'a',
    'd',
    'e'
  ])
  check('dragging left lands on the target index', ids(moveTab(five5, 'e', 'b')), [
    'a',
    'e',
    'b',
    'c',
    'd'
  ])
  check('dropping a tab on itself changes nothing', ids(moveTab(five5, 'c', 'c')), five)
  check('an unknown drag id changes nothing', ids(moveTab(five5, 'zz', 'c')), five)
  check('an unknown target changes nothing', ids(moveTab(five5, 'a', 'zz')), five)
  check('the input list is not mutated', ids(five5), five)
  ```

- [ ] **Step 2: Run it and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected:
  `SyntaxError: The requested module '../src/renderer/src/lib/tabs.ts' does not provide an export named 'moveTab'`.

- [ ] **Step 3: Write it.**
  Append to `/Users/thevinh/dev/personal/stoke/src/renderer/src/lib/tabs.ts`:

  ```ts
  /**
   * `dragId` moved to `overId`'s index, as a new array.
   *
   * Splice-out-then-splice-in, so dragging right lands *after* the target and
   * dragging left lands *before* it — which is what the pointer is over in each
   * case. An unknown id on either side returns the same list rather than
   * throwing: a drop can land after the tab it was aimed at has closed.
   */
  export function moveTab<T extends { id: string }>(
    list: T[],
    dragId: string,
    overId: string
  ): T[] {
    const from = list.findIndex((t) => t.id === dragId)
    const to = list.findIndex((t) => t.id === overId)
    if (from < 0 || to < 0 || from === to) return list
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }
  ```

- [ ] **Step 4: Run it and watch it pass.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/verify-tabs.mts
  ```
  Expected: `all pass`.

- [ ] **Step 5: Wire it into App.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/App.tsx`, change the `lib/tabs` import to
  `import { moveTab, neighbourOf } from './lib/tabs'`, add beside `openNewTab`:

  ```tsx
    const reorderTab = useCallback((dragId: string, overId: string): void => {
      // Keyed by tab id in the render, so React moves the DOM nodes rather than
      // rebuilding them — and ptyBus replays the retained scrollback anyway, so
      // even a rebuild would not blank a terminal.
      setTabs((list) => moveTab(list, dragId, overId))
    }, [])
  ```

  and pass `onReorderTab={reorderTab}` to `<TitleBar>`.

- [ ] **Step 6: Add the drag handlers.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/components/TitleBar.tsx`:
  - add `import { useState } from 'react'` at the top;
  - add to `Props`:

  ```ts
    /** Reorder: the dragged tab takes the target's index. */
    onReorderTab: (dragId: string, overId: string) => void
  ```

  and to the destructured list;
  - add inside the component, before the `return`:

  ```tsx
    const [dragId, setDragId] = useState<string | null>(null)
    const [overId, setOverId] = useState<string | null>(null)
  ```

  - add these attributes to the `.tab` `<div>`, after `title=`:

  ```tsx
              draggable
              data-dragging={tab.id === dragId ? 'true' : undefined}
              data-drop={tab.id === overId ? 'true' : undefined}
              onDragStart={(e) => {
                setDragId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                // Chromium refuses to begin a drag with an empty payload.
                e.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setOverId(tab.id)
              }}
              onDragLeave={() => setOverId((cur) => (cur === tab.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== tab.id) onReorderTab(dragId, tab.id)
                setDragId(null)
                setOverId(null)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
  ```

- [ ] **Step 7: Style the drag.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add after the
  `.tab[aria-selected='true']::before` rule:

  ```css
  .tab[data-dragging='true'] {
    opacity: 0.4;
  }

  /* Where it will land. An inset outline rather than a background, so it does
     not read as hover on the tab the pointer happens to be over. */
  .tab[data-drop='true'] {
    outline: 1px dashed var(--accent);
    outline-offset: -1px;
  }
  ```

- [ ] **Step 8: Rebuild and drive a real drag over CDP.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run typecheck && npm run build
  ```
  Reload, open three tabs with distinguishable labels, then:
  ```bash
  node scripts/cdp-eval.mjs "(async () => { const labels = () => [...document.querySelectorAll('.tablist .tab .tab-label')].map((s) => s.textContent); const before = labels(); const tabs = [...document.querySelectorAll('.tablist .tab')]; const dt = new DataTransfer(); tabs[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); await new Promise((r) => setTimeout(r, 30)); tabs[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); tabs[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); await new Promise((r) => setTimeout(r, 60)); return { before, after: labels() } })()"
  ```
  Expected: `after` is `before` with its first entry moved to the end — e.g.
  `{"before":["one","two","three"],"after":["two","three","one"]}`.

- [ ] **Step 9: Prove a dragged terminal did not lose its scrollback.**
  Screenshot the window after the drag (`screencapture -o -x /tmp/stoke-after-drag.png`) with the
  moved session tab selected. The terminal must still show its output — the DOM is empty for a
  WebGL renderer (gotcha 5), so a screenshot is the only way to see this.

- [ ] **Step 10: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && \
    git add src/renderer/src/lib/tabs.ts scripts/verify-tabs.mts src/renderer/src/App.tsx src/renderer/src/components/TitleBar.tsx src/renderer/src/styles/app.css && \
    git commit -m "Let tabs be dragged into the order you want them in

Tab order was append-only, so a session opened an hour ago could never be moved
next to the one it belongs beside. The list arithmetic is a pure function with a
suite because the alternative — clicking and looking — cannot distinguish 'lands
before' from 'lands after'. Terminals survive the move: the render is keyed by tab
id and ptyBus replays retained scrollback on any remount."
  ```

---

### Task 94: Tighten the tab label, and re-measure the whole strip

The strip is finished. This applies the one typography token it owes (`--lh-tight`, contracts §0.6:
"applied by workstream A to `.tab-label`") and re-measures every number this workstream claimed, in
one pass, on the final code.

**Files:**
- Modify: `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css` (the `.tab-label`
  rule)
- Test: one combined `scripts/cdp-eval.mjs` measurement, plus `npm run check`.

**Interfaces:**
- Consumes: `--lh-tight` (contracts Task 4).
- Produces: nothing new.

- [ ] **Step 1: Measure the label's line box, and watch it fail.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "getComputedStyle(document.querySelector('.tab-label')).lineHeight"
  ```
  Expected: `"20.15px"` — `body`'s inherited `--lh-normal` (1.55) applied to a 13px label, which is
  five pixels of leading a single-line control has no use for.

- [ ] **Step 2: Apply the token.**
  In `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, add to the `.tab-label`
  rule:

  ```css
    /* A single-line control has no use for body leading, and the extra height
       fights the fixed 14px indicator slot beside it. */
    line-height: var(--lh-tight);
  ```

- [ ] **Step 3: Rebuild and re-measure.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run build
  ```
  Reload and re-run Step 1.
  Expected: `"16.25px"` (13px × 1.25).

- [ ] **Step 4: Re-measure every claim this workstream made, in one call.**
  With one session tab open, one New Project tab open, and the docked browser open:
  ```bash
  cd /Users/thevinh/dev/personal/stoke && node scripts/cdp-eval.mjs "(() => { const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(2) }; const tab = document.querySelector('.tab'); const close = tab.querySelector('.tab-close'); const cr = close.getBoundingClientRect(); const cg = close.querySelector('svg').getBoundingClientRect(); const ind = tab.querySelector('.tab-indicator').getBoundingClientRect(); const t = tab.getBoundingClientRect(); return { closeLeft: +(cg.left - cr.left).toFixed(2), closeRight: +(cr.right - cg.right).toFixed(2), barIcon: mid(document.querySelector('.titlebar-actions .icon-btn')), plus: mid(document.querySelector('.tabs > .icon-btn')), indicatorMid: mid(tab.querySelector('.tab-indicator')), indicatorW: +ind.width.toFixed(2), tabTop: +t.top.toFixed(2), tabBottom: +t.bottom.toFixed(2), nonTabChildren: [...document.querySelectorAll('[role=\"tablist\"]')].map((l) => [...l.children].filter((c) => c.getAttribute('role') !== 'tab').length) } })()"
  ```
  Expected:
  ```json
  {"closeLeft":3.5,"closeRight":3.5,"barIcon":21.5,"plus":21.5,"indicatorMid":21.5,"indicatorW":14,"tabTop":4,"tabBottom":43,"nonTabChildren":[0,0]}
  ```
  (`closeLeft`/`closeRight` are `3` and `3` once workstream F's 12px icon lands; the assertion is
  that they are equal.)

- [ ] **Step 5: Screenshot the finished strip.**
  `screencapture -o -x /tmp/stoke-strip-final.png`, with a running session, an exited session, a
  watched session and a New Project tab all in the strip. Confirm by eye: one baseline, one width
  per indicator, exactly one red dot and it is on the watched session.

- [ ] **Step 6: Run the whole check.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && npm run check
  ```
  Expected: exit 0, including `verify:tabs` and `verify:context`.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/thevinh/dev/personal/stoke && git add src/renderer/src/styles/app.css && \
    git commit -m "Give the tab label its single-line leading

A tab label inherited body leading of 1.55, which is five pixels of space a
one-line control cannot use and which fought the fixed 14px indicator slot beside
it. Closes workstream A: the close mark, the indicator and every title-bar icon
now share one centreline at 21.5, the indicator is 14px wide in every state, and
both tablists contain only tabs."
  ```
