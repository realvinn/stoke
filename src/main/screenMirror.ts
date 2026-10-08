/**
 * A headless copy of one pty's screen, so a terminal that attaches late is
 * handed the screen as it is now rather than the bytes that drew it.
 *
 * The phone and the hub's remote tabs used to get the last 512 KB of raw
 * output (`historyFor`), and that is not a screen. Claude Code's full-screen
 * renderer repaints only what changes, so once a session outgrew the cap the
 * replay began after its launch (the alternate screen and mouse reporting
 * were gone, `ReplayModes`) AND after the last time it drew anything that has
 * not changed since: measured 2026-10-04 on a 744 KB session, the replay's
 * bottom three rows were blank where the live tab showed the input box and
 * the footer. A remote tab that reconnects claims nothing (gotcha 151), so no
 * resize made Claude repaint, and the view stayed like that — the status bar
 * missing, the wheel scrolling stale frames — until something changed there.
 *
 * The mirror is xterm itself (`@xterm/headless`), fed every chunk the pty
 * prints, and `snapshot()` is xterm's own serializer over it: the normal
 * screen and its scrollback, the alternate screen when it is up, the cursor,
 * and the modes. VS Code reconnects its terminals the same way. Three things
 * make it exact:
 *
 * - **Parsing is asynchronous, a snapshot is not.** `write` queues; the
 *   parser runs on a later turn. Each chunk is kept in `unparsed` until its
 *   write callback (which xterm runs right after that chunk, before the
 *   next), so a snapshot is the serialized parsed part followed by the raw
 *   part not parsed yet: everything printed so far, in order, at any moment.
 *   That keeps `historyFor` synchronous, so an attach still sends the replay
 *   and subscribes in one turn and no byte falls between them.
 * - **The serializer leaves modes out.** It writes the mouse protocol but not
 *   its encoding (SGR, 1006, is not on xterm's public `modes`), nor cursor
 *   visibility, nor 2031, so `ReplayModes` reads every chunk too and its
 *   preamble, minus the screen, closes the snapshot.
 * - **Widths match all three viewers.** Local, phone and remote terminals
 *   use the same Unicode 15 grapheme addon, including this mirror. Mixing
 *   width tables shifts emoji and the cells following them on replay.
 *
 * CLAUDE.md gotcha 159.
 */
import * as headlessModule from '@xterm/headless'
// The ES module file by path: the package's typings would pull the DOM into main (addonSerialize.d.ts).
import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.mjs'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs'
import { ReplayModes } from '../shared/replayModes.ts'

/*
 * @xterm/headless is CommonJS to node, which is how the suites load this file
 * (strip-types): the namespace holds `default`, the module's exports. The
 * bundle main ships may hold the class on the namespace itself. Take
 * whichever is there.
 */
const { Terminal } = (headlessModule as typeof headlessModule & { default?: typeof headlessModule }).default ?? headlessModule

/** Lines of normal-screen history a snapshot carries (the alternate screen has none). */
export const MIRROR_SCROLLBACK = 2000

export class ScreenMirror {
  private term: InstanceType<typeof Terminal>
  private serializer: InstanceType<typeof SerializeAddon>
  /** Chunks written but not parsed yet, oldest first. */
  private unparsed: string[] = []
  /** Every mode the stream has set, for what the serializer leaves out. */
  private modes = new ReplayModes()
  private disposed = false
  /** xterm refused a write (it throws past 50 MB queued): the copy is no longer the screen. */
  private failed = false

  /** `scrollOnEraseInDisplay` as the desktop's tab has it (a kept SSH session, gotcha 126). */
  constructor(cols: number, rows: number, opts: { scrollOnEraseInDisplay?: boolean } = {}) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: MIRROR_SCROLLBACK,
      allowProposedApi: true,
      scrollOnEraseInDisplay: opts.scrollOnEraseInDisplay === true
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(new UnicodeGraphemesAddon())
    this.term.unicode.activeVersion = '15-graphemes'
    this.term.loadAddon(this.serializer)
  }

  write(data: string): void {
    if (this.disposed || this.failed || !data) return
    this.unparsed.push(data)
    this.modes.feed(data)
    try {
      this.term.write(data, () => {
        this.unparsed.shift()
      })
    } catch {
      this.failed = true
      this.unparsed = []
    }
  }

  /** At once, as the desktop's own terminal does: output still queued is laid out at the new size, and the CLI repaints for it anyway. */
  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows)) return
    this.term.resize(cols, rows)
  }

  /** What a fresh terminal of this size has to be written to show this screen now; null once the copy has failed. */
  snapshot(): string | null {
    if (this.disposed || this.failed) return null
    return this.serializer.serialize({ scrollback: MIRROR_SCROLLBACK }) + this.unparsed.join('') + this.modes.preamble({ screen: false })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unparsed = []
    this.term.dispose()
  }
}
