/**
 * The campfire the installer burns while it downloads: the art, which frame is
 * on screen at a given progress, the four colour tiers, and the honest text
 * that replaces all of it when the terminal cannot draw.
 *
 * This module is the ONLY definition of any of that. `scripts/gen-installer-art.mts`
 * emits the art blocks the shell and PowerShell installers carry, the way
 * `scripts/gen-themes.mts` emits a theme literal (gotcha 43), and
 * `scripts/verify-campfire.mts` asserts the shipped blocks still equal this
 * module's output byte for byte. Hand-editing an art block in a script is
 * therefore a failing check rather than a thing nobody notices — which matters,
 * because the segment encoding below was hand-written once during research and
 * shipped two malformed rows that printed a literal `||` at the user.
 *
 * Pure by requirement, not by taste: no imports at all (gotcha 27 — `src/shared`
 * is compiled by the web tsconfig too, which has no Node types), no RNG and no
 * clock, so `node --experimental-strip-types scripts/verify-campfire.mts` can
 * import it and pin every frame by hash.
 */

/**
 * Fixed for every frame, and load-bearing rather than cosmetic. Redraw in place
 * is `ESC[7A` and nothing else, so a frame with fewer rows would walk the cursor
 * up a line per tick and smear the fire up the screen. Short stages are padded
 * with EMPTY rows, never shortened.
 */
export const CANVAS = { rows: 7, cols: 15 } as const

/**
 * The last two rows of every frame, byte-identical in all twelve. A fire that
 * grows only reads as growth if the ground under it never moves; a hearth that
 * drifted by one column in one frame is the kind of defect a single screenshot
 * cannot show. It is stored ONCE and appended by `frameFor`, so no frame can
 * disagree with another about it by construction.
 */
export const HEARTH: readonly [string, string] = ['\\__/\\_/_\\_/\\__/', '.-.,_______,.-.']

/** Rows 0-4 of a frame are flame; 5 and 6 are the hearth. */
export const FLAME_ROWS = 5

export type StageName = 'spark' | 'kindling' | 'burning' | 'roaring'

/**
 * Every character the art is allowed to use, and nothing else. This is a
 * quoting contract, not a style: the same bytes have to survive inside a POSIX
 * single-quoted string AND a PowerShell single-quoted here-string, unescaped,
 * in a file two different shells parse.
 *
 * What is banned, and why each one costs an afternoon if it comes back:
 *   `'`  ends a POSIX single-quoted string. This is why the sparks are `^` and
 *        the ground is `.-.,…,.-.` rather than `'-.,…,.-'`.
 *   `` ` ``  PowerShell's escape character, and command substitution inside a
 *        POSIX double-quoted string.
 *   `$`  expands in both shells.
 *   `"`  a quoting collision in both.
 *   `@`  a line beginning `'@` ends a PowerShell here-string. Banning `@`
 *        outright removes the whole class rather than one instance of it.
 *   anything above 0x7E — a PowerShell 5.1 console is often on cp437 or cp1252,
 *        where UTF-8 box drawing mojibakes. An installer whose first act is to
 *        print `â–ˆ` has already lost. A Unicode upgrade can be layered behind a
 *        code-page probe later; it must not be the base.
 *
 * `*` is a glob character and is safe only because every expansion is quoted
 * and everything is printed with `printf '%s'`.
 */
export const ALPHABET = ' ()/\\_-.,*#=^'

/** True when every character of `text` is in the alphabet above. */
export function inAlphabet(text: string): boolean {
  for (const ch of text) if (!ALPHABET.includes(ch)) return false
  return true
}

/**
 * The twelve frames: four stages of three flicker frames each. Flame rows are
 * stored right-trimmed — the renderer emits `ESC[K` per row rather than padding
 * to 15, which is 3 bytes instead of up to 15 and is correct at any width.
 */
export const STAGES: readonly { name: StageName; frames: readonly (readonly string[])[] }[] = [
  {
    name: 'spark',
    frames: [
      ['', '', '', '       .', '      (*)'],
      ['', '', '', '         ^', '      (,)'],
      ['', '', '', '     ,', '      (.)']
    ]
  },
  {
    name: 'kindling',
    frames: [
      ['', '', '       .', '      ( )', '     (###)'],
      ['', '', '        ^', '      ) (', '     (#=#)'],
      ['', '', '      ,', '      ( )', '     (#*#)']
    ]
  },
  {
    name: 'burning',
    frames: [
      ['', '      . ^', '     ) ( )', '    ( (#) )', '   ( (###) )'],
      ['', '     ^  .', '     ( ) (', '    ) (#) (', '   ( (###) )'],
      ['', '       * .', '     ( ) )', '    ( (#) )', '   (_(###)_)']
    ]
  },
  {
    name: 'roaring',
    frames: [
      ['   .   *   .', '    \\ ) ( /', '   ( )(#)( )', '  ( ((###)) )', ' (_((#####))_)'],
      ['  *   .    ^', '   ( \\ ) (/)', '  ( )( # )( )', '  ( ((###)) )', ' (_((#####))_)'],
      ['   ^  .  *  .', '    ) ( \\ /', '   ( )(#)( )', '  ( ((###)) )', ' (_((#####))_)']
    ]
  }
]

/**
 * Which flicker frame a tick shows. Deterministic on purpose: an RNG cannot be
 * pinned by a test, and a bare 3-cycle reads as a metronome rather than as a
 * flame. Six entries over three frames is the cheapest thing that does not.
 */
export const FLICKER: readonly number[] = [0, 1, 2, 1, 0, 2]

/**
 * Where one stage becomes the next, as a fraction of the download. The first
 * thing printed — before a single byte has arrived — is spark frame 0, so the
 * fire is lit by starting the install rather than by finishing it.
 */
export const STAGE_THRESHOLDS: readonly number[] = [0.08, 0.35, 0.75]

/** Milliseconds between frames. 8 fps: faster reads as frantic, slower as laggy. */
export const FRAME_MS = 125

function clamp01(progress: number): number {
  if (!(progress > 0)) return 0 // also catches NaN
  return progress > 1 ? 1 : progress
}

/** The stage index (0-3) for a progress fraction. Out-of-range values clamp. */
export function stageIndexFor(progress: number): number {
  const p = clamp01(progress)
  let i = 0
  while (i < STAGE_THRESHOLDS.length && p >= STAGE_THRESHOLDS[i]) i++
  return i
}

/** The stage name for a progress fraction. */
export function stageFor(progress: number): StageName {
  return STAGES[stageIndexFor(progress)].name
}

/**
 * The seven rows on screen for a progress fraction and a tick counter: five
 * flame rows (right-trimmed, possibly empty) and the two hearth rows. Always
 * seven, for the reason `CANVAS` gives.
 */
export function frameFor(progress: number, tick: number): string[] {
  const stage = STAGES[stageIndexFor(progress)]
  const flicker = FLICKER[((tick % FLICKER.length) + FLICKER.length) % FLICKER.length]
  return [...stage.frames[flicker], ...HEARTH]
}

/**
 * The colour a glyph is painted in. One letter each, because the letter IS the
 * wire format: a segment-encoded row is `KEY:text|KEY:text`, and the installer
 * maps one letter to one palette variable with parameter expansion and no fork.
 */
export type ColorKey = '_' | 'C' | 'S' | 'M' | 'B' | 'L'

/** Every key, in heat order after `_`, which is "emit no sequence at all". */
export const COLOR_KEYS: readonly ColorKey[] = ['_', 'C', 'S', 'M', 'B', 'L']

/**
 * Which colour one glyph gets.
 *
 * Colouring by ROW alone is the obvious implementation and it is wrong — caught
 * by running it, not by reading it. At the spark stage the only content is on
 * rows 3-4, so a row map paints the ember in the DIMMEST colour and the fire
 * starts out looking like ash. Glyph class comes first, row second: that makes
 * the tiny `(*)` read as a dark ring with a white-hot centre and the `#####`
 * core read as the hottest part of a roaring fire, from one rule.
 */
export function colorFor(ch: string, rowIndex: number): ColorKey {
  if (ch === ' ') return '_'
  if (rowIndex >= FLAME_ROWS) return 'L' // the hearth is logs, whatever the glyph
  if (ch === '#' || ch === '*') return 'C'
  if (ch === '.' || ch === ',' || ch === '^') return 'S'
  if (rowIndex <= 1) return 'S'
  if (rowIndex <= 3) return 'M'
  return 'B'
}

/** One row split into runs of a single colour. */
export function segmentRow(row: string, rowIndex: number): { key: ColorKey; text: string }[] {
  const out: { key: ColorKey; text: string }[] = []
  for (const ch of row) {
    const key = colorFor(ch, rowIndex)
    const last = out[out.length - 1]
    if (last && last.key === key) last.text += ch
    else out.push({ key, text: ch })
  }
  return out
}

/**
 * One row as `KEY:text|KEY:text`. `|` and `:` are both outside the alphabet, so
 * neither delimiter can appear in the payload and the split is unambiguous.
 *
 * The point of pre-segmenting at generation time is that the draw loop then
 * forks nothing: per-glyph colour normally means an `awk` or `sed` per frame,
 * and forking eight times a second beside a download is both slow and noisy.
 * The cost is 539 bytes of plain art becoming ~1.2 KB encoded, paid once.
 */
export function encodeRow(row: string, rowIndex: number): string {
  return segmentRow(row, rowIndex)
    .map((s) => `${s.key}:${s.text}`)
    .join('|')
}

/**
 * The inverse. Strict on both halves: a segment with no `:`, or one naming a
 * key that is not in the palette, is a malformed encoding rather than literal
 * text. Saying so is the whole value of the round trip — a shell decoder would
 * silently print an unknown key's text uncoloured, which is precisely the
 * failure that shipped a visible `||` once.
 */
export function decodeRow(encoded: string): string {
  if (encoded === '') return ''
  let out = ''
  for (const part of encoded.split('|')) {
    const colon = part.indexOf(':')
    if (colon !== 1 || !COLOR_KEYS.includes(part[0] as ColorKey)) {
      throw new Error(`campfire: malformed segment ${JSON.stringify(part)}`)
    }
    out += part.slice(colon + 1)
  }
  return out
}

/**
 * The four colour tiers. `none` is a real tier — a monochrome silhouette — not
 * the absence of the feature.
 */
export type ColorMode = 'truecolor' | 'ansi256' | 'ansi16' | 'none'

/** ESC, as a source escape rather than a literal control byte in this file. */
export const ESC = '\u001b'

/**
 * The palette, as the bytes that FOLLOW ESC. Kept without the escape byte so
 * the generator can write them into shell and PowerShell source, where a raw
 * ESC would be both unreadable and unsearchable; `printf '\033'` (octal, POSIX
 * — `\e` is a bash/zsh extension that dash and busybox ash do not have) or
 * `[char]27` supplies it at runtime.
 *
 * Derived from `build/icon.svg`'s own gradients (flame #ffc48c -> #ff9552 ->
 * #e85f24, core #fff3e2). The log brown is the one colour not in the brand
 * file, so it is DERIVED rather than invented: 45% flame #e85f24 over 55% page
 * #241c17 = #7c3a1d, which keeps it inside the brand pair — the same rule
 * `ladder.ts` and `accent.ts` already set here (gotcha 43: do not hand-pick a
 * hex).
 *
 * The 256 indices are nearest neighbours in the xterm cube, computed rather
 * than guessed: 230 #ffffd7 (d^2 265 against 255's 458), 216 #ffaf87 (466
 * against 223's 1586), 209 #ff875f (365 against 215's 845), 166 #d75f00 (1585
 * against 208's ~2400), 94 #875f00 (2331 against 58's 3051).
 *
 * The 16-colour tier is deliberately 8-COLOUR SAFE: SGR 30-37 plus SGR 1, never
 * the aixterm 90-97 brights. Microsoft's own table defines SGR 1 as "applies
 * brightness/intensity flag to foreground color", which is exactly the
 * promotion wanted, and it is the tier bare conhost gets by design rather than
 * as a degradation — the Windows console host rounds 24-bit and 256-colour SGR
 * to the nearest of its own sixteen, and #e85f24, #ff9552 and #ffc48c are close
 * enough that it can collapse all three into one red.
 */
export const SGR: Record<Exclude<ColorMode, 'none'>, Record<ColorKey, string>> = {
  truecolor: {
    _: '',
    C: '[38;2;255;243;226m',
    S: '[38;2;255;196;140m',
    M: '[38;2;255;149;82m',
    B: '[38;2;232;95;36m',
    L: '[38;2;124;58;29m'
  },
  ansi256: {
    _: '',
    C: '[38;5;230m',
    S: '[38;5;216m',
    M: '[38;5;209m',
    B: '[38;5;166m',
    L: '[38;5;94m'
  },
  ansi16: {
    _: '',
    C: '[1;37m',
    S: '[1;33m',
    M: '[0;33m',
    B: '[1;31m',
    L: '[0;31m'
  }
}

/** SGR 0, as the bytes after ESC. */
export const RESET = '[0m'

/**
 * The rows, coloured, joined by newlines. Colour only: no cursor movement and
 * no erase-in-line, so `paint(rows, 'none')` contains no escape byte at all and
 * the caller owns the redraw. Stripping the SGR sequences from any mode returns
 * exactly the rows that went in — no glyph is gained or lost by colouring it.
 *
 * Two byte-saving details, both safe because only the FOREGROUND is ever set.
 * A run of spaces emits no sequence and does not end the one in effect, so
 * `( )` inside one tier costs one sequence rather than two — worth 19 bytes a
 * time at truecolor, and there are a lot of interior spaces in this art. And a
 * sequence equal to the one already in effect is skipped. Each row still ends
 * with a reset, which is not optional: leaving a foreground live across the
 * newline would colour whatever the installer prints next.
 */
export function paint(rows: readonly string[], mode: ColorMode): string {
  if (mode === 'none') return rows.join('\n')
  const table = SGR[mode]
  return rows
    .map((row, i) => {
      let out = ''
      let active = ''
      for (const seg of segmentRow(row, i)) {
        const seq = table[seg.key]
        if (seq && seq !== active) {
          out += ESC + seq
          active = seq
        }
        out += seg.text
      }
      return active ? out + ESC + RESET : out
    })
    .join('\n')
}

/** What the installer was asked to draw on, as far as anything can tell. */
export interface Terminal {
  /** Whether stdout is a terminal at all. */
  isTty: boolean
  /** `process.platform`, passed in so a suite can ask about another machine. */
  platform: string
  /** The window, when it is knowable. Unknown is not a reason to degrade. */
  rows?: number
  cols?: number
}

/** Below either of these the canvas cannot be drawn without smearing. */
export const MIN_ROWS = 12
export const MIN_COLS = 20

/**
 * Why the animation must not run, or null if it may. The string is written to
 * be printable — it is the honest answer to "why is there no fire?".
 *
 * `NO_COLOR` is deliberately NOT here. no-color.org says the variable, "when
 * present and not an empty string (regardless of its value), prevents the
 * addition of ANSI color" — it says nothing about motion, and the art is a
 * silhouette that reads perfectly without colour. Removing the animation for it
 * is the part of that spec everyone gets wrong. `TERM=dumb`, a pipe and CI are
 * a different claim: those say this thing cannot render cursor movement.
 */
export function degradedReason(env: Record<string, string | undefined>, term: Terminal): string | null {
  if (env.STOKE_NO_ANIMATION) return 'STOKE_NO_ANIMATION is set'
  if (!term.isTty) return 'stdout is not a terminal'
  if (env.TERM === 'dumb') return 'TERM is dumb'
  // Unset TERM means a terminal that has told us nothing — on POSIX. On Windows
  // it is simply the norm, and VT there is decided by the host, not by TERM.
  if (term.platform !== 'win32' && !env.TERM) return 'TERM is unset'
  if (env.CI || env.GITHUB_ACTIONS || env.TF_BUILD) return 'this is CI'
  if (term.rows !== undefined && term.rows < MIN_ROWS) return `the window is under ${MIN_ROWS} rows`
  if (term.cols !== undefined && term.cols < MIN_COLS) return `the window is under ${MIN_COLS} columns`
  return null
}

/**
 * Which colour tier to paint in. `none` covers both the monochrome animation
 * (NO_COLOR) and the degraded path, which prints no escape byte at all.
 *
 * Windows is the one platform where the tier is not a guess: unless Windows
 * Terminal or COLORTERM says otherwise, bare conhost gets the hand-tuned
 * 16-colour tier, because its own documentation says it rounds anything richer
 * to the nearest of sixteen. TERM is not consulted there — a false positive
 * prints `[38;2;255;149;82m` at someone as the first thing Stoke ever does,
 * which is the worst available first impression.
 */
export function colorMode(env: Record<string, string | undefined>, term: Terminal): ColorMode {
  if (degradedReason(env, term)) return 'none'
  if (env.NO_COLOR) return 'none'
  if (env.WT_SESSION) return 'truecolor'
  if (env.COLORTERM && /truecolor|24bit/i.test(env.COLORTERM)) return 'truecolor'
  if (term.platform === 'win32') return 'ansi16'
  if (env.TERM && env.TERM.includes('256color')) return 'ansi256'
  return 'ansi16'
}

/** Everything the installer needs to decide what to draw, in one answer. */
export interface RenderPlan {
  animate: boolean
  color: ColorMode
  /** Why it is not animating, or null. Safe to print. */
  reason: string | null
}

export function renderPlan(env: Record<string, string | undefined>, term: Terminal): RenderPlan {
  const reason = degradedReason(env, term)
  return { animate: reason === null, color: colorMode(env, term), reason }
}

/**
 * Bytes as a figure in MB, where MB is 10^6 — SI, which is what the label says.
 */
export function formatMb(bytes: number): string {
  return (Math.max(0, bytes) / 1e6).toFixed(1)
}

/** How far the download has to move before the degraded path says so again. */
const UNKNOWN_TOTAL_STEP = 10e6

/**
 * Which decile of the download `done` is in, or — when the server sent no
 * Content-Length — which 10 MB it is in. Either way it is the thing that must
 * CHANGE before another line is printed.
 */
export function decileOf(done: number, total: number | null): number {
  const got = Math.max(0, done)
  if (total === null || !(total > 0)) return Math.floor(got / UNKNOWN_TOTAL_STEP)
  return Math.min(10, Math.floor((got * 10) / total))
}

/**
 * One line of the degraded path, or null when nothing new has happened.
 *
 * The loop ticks eight times a second; this prints on a decile change and
 * nothing else, so a 40-second install leaves eleven lines in a CI log rather
 * than 320. Append-only, no `\r`, no escape byte: `tee`, `| less`, a CI log
 * viewer and a support paste all show the same thing afterwards.
 *
 * With no Content-Length there is no percentage — just the megabytes. A
 * fabricated percent in a log that someone later reads back is worse than no
 * percent at all.
 */
export function plainProgress(done: number, total: number | null, lastDecile: number): string | null {
  const decile = decileOf(done, total)
  if (decile <= lastDecile) return null
  const mb = `${formatMb(done)} MB`
  if (total === null || !(total > 0)) return mb.padStart(9)
  return `${decile * 10}%`.padStart(6) + '  ' + mb
}
