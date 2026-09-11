---
paths:
  - "src/shared/drop.ts"
  - "scripts/verify-drop.mts"
  - "src/renderer/src/components/TerminalView.tsx"
  - "src/preload/index.ts"
---

# File drop on the terminal

What a file dropped on the terminal types, and the ways a drop can fail silently. Loaded when a
file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are permanent — code
comments cite them as "CLAUDE.md gotcha N".

## 59. Dropping a file into the terminal is four separate traps, and three of them fail silently

**Dropping a file into the terminal is four separate traps, and three of them fail
silently.** All measured against the built app on Electron 43, with a real OS drop
dispatched over CDP rather than a synthetic `DragEvent`.

**`File.path` is gone.** Electron 32 removed it; `webUtils.getPathForFile(file)` replaced
it. Proven in one call: for the same dropped file `pathForFile` returned
`/tmp/Screenshot 2026-09-02 at 6.11.05 pm.png` and `file.path` returned **null** — so the
obvious implementation pastes nothing and looks like a handler that never fired. It is a
*renderer-side* API (`electron.d.ts:19628`), so main cannot answer it, and the renderer has
no `electron` import to call it with: the **preload** is the only process holding both
halves, which is why `pathForFile` lives on `window.stoke` rather than behind an IPC channel.

**`preventDefault` on `dragover` is load-bearing twice.** Without it no `drop` event fires
at all — and Chromium's default action for a file dropped on a page is to **navigate to
it**, which in a single-page Electron app replaces the entire UI with a picture of the file
with no way back but relaunching. `createWindow` now refuses navigation outright
(`will-navigate`, compared against the current URL so a reload still passes) as the backstop
for every pixel the terminal pane does not claim.

**Only a drag carrying files may be taken.** The tab strip drags a tab as `text/plain`
(`TitleBar.tsx:162`), so a handler that does not test `dataTransfer.types` for `Files`
lights its drop affordance and pastes nothing every time a tab is dragged across the
terminal. And `dragleave` fires on crossing into a **child** — the pane is full of xterm's
canvases — so the affordance needs an enter/leave depth counter or it flickers off
immediately.

**The quoting is the feature.** The single most likely file anyone will ever drop here is a
macOS screenshot, and its name has four spaces in it: one argument to the CLI's prompt,
four at a shell prompt, and an SSH tab can be sitting at a real shell (gotcha 10). POSIX
gets **single** quotes — inside them every character but `'` is literal, so `$`, backticks
and backslashes cannot bite, and the one exception is escaped by closing and reopening.
Windows gets double quotes and no escaping, since `"` is not legal in a path there.

One thing that must be refused rather than quoted: **a newline in a filename.**
`Terminal.paste()` rewrites every `\n` to a bare `\r` (`Clipboard.ts:14,21-26`), which is
Enter — so such a file would not insert a path, it would **submit whatever the user had
half-written**. POSIX permits the name, so this is reachable rather than theoretical.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - `quotePath` (src/shared/drop.ts:44-47) still works this way, but the caller no longer always passes Stoke's own platform. src/renderer/src/components/TerminalView.tsx:1135 calls `dropText(paths, tab.hostId ? 'linux' : window.stoke.platform)`, so a drop on any SSH tab is POSIX single-quoted even when Stoke runs on Windows. Only a local tab on Windows gets double quotes.

> **Checked against the code on 2026-09-11** — after the tab strip moved to pointer events.
> - The tab strip no longer drags as `text/plain`. `TitleBar.tsx` has no `draggable`, `setData` or `dataTransfer` left; a tab is dragged by `useTabDrag` (src/renderer/src/lib/useTabDrag.ts) with pointer events, pointer capture on `.tablist` and transforms, and emits no DragEvent at all — so it can no longer light the terminal's drop ring, and no tab id leaves the window as text. The `Files` guard in `TerminalView` still stands, for text dragged in from another app or out of the docked browser, which does arrive as `text/plain`.
