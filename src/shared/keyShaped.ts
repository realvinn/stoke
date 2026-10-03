/*
 * Key-shaped text, judged by its shape alone: the share path's safety net
 * (gotcha 156). The index's secret patterns (chatIndex/parse.ts
 * `redactSecrets`) know a key by its provider's shape, and five rule sets
 * still let 44 of 46 fresh shapes through to another computer — a WireGuard
 * key, a Twilio pair, a PyPI token, an age key. No list of providers ends.
 * What another of the owner's computers receives therefore goes through this
 * too, after the patterns: any run of token characters long and random
 * enough to be a key becomes `[redacted]` (`redactKeyShaped`), and a search
 * that looks like a key is refused before it is run (`keyShapedQuery`), so an
 * unknown shape cannot be walked one prefix at a time from hit counts either.
 *
 * Only on the way OUT (`sharedChats`, main/hub/chatShare.ts): the local index
 * and the local viewer keep the patterns alone, as this takes ids and hashes
 * too, which the owner searches for on their own computer.
 *
 * Pure and linear: one pass of a plain character class over the text, then a
 * walk over each run; no pattern here can backtrack.
 */

/** What a taken run becomes: the index's own marker (chatIndex/parse.ts `REDACTED`). */
export const KEY_SHAPED_MARK = '[redacted]'

/** A run this long, at least, may be a key; anything shorter is left to the patterns. */
export const KEY_SHAPED_MIN = 20

/*
 * A run: letters, digits, `_`, `+`, `=` and `-`. Everything else ends it — a
 * space, a quote, a slash, a dot, a colon, a comma, a bracket — so a path, a
 * URL, a dotted name and the pieces of a base64 blob are judged one by one.
 * `=` stays inside (base64's padding, a token's own `=`); a run taken whole
 * keeps a plain `name=` before its value (`NAME_HEAD`).
 */
const RUN = /[A-Za-z0-9_+=-]+/g

/** A UUID inside a run: a session id, a request id, a file name's. Never a key here. */
const UUID = /(?<![A-Za-z0-9])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9])/g
/** A git commit's full id. */
const GIT_SHA = /^[0-9a-f]{40}$/
/** 32 hex or more (a `0x` before it too): a key, or a SHA-256 — lost from a shared view, which is accepted. */
const HEX = /^(?:0x)?[0-9a-fA-F]{32,}$/

/**
 * A stretch read as a name would be: cut into pieces — a run of digits, a
 * word in lower case or capitalised (`parse`, `Url`), a run of capitals
 * (`SHA`, `IPKCS`; the last capital before lower case starts the next word).
 * `switches` counts the pieces after the first that are NOT a word: three
 * letters or more with a vowel in them. A name changes piece at every word
 * and is charged only for its numbers and its short pieces
 * (`base64urlToUint8Array`: `64`, `To`, `8`); a random string is mostly short
 * pieces, and its longer ones seldom read as words. `changes` counts every
 * change between a digit, a capital and a lower-case letter, the measure for
 * a stretch in one case, where pieces would be whatever lies between digits.
 */
interface Shape {
  alnum: number
  upper: number
  lower: number
  digit: number
  switches: number
  changes: number
}

/** 1 a digit, 2 a capital, 3 a lower-case letter, 0 anything else. */
function kindAt(s: string, i: number): number {
  const c = s.charCodeAt(i)
  return c >= 48 && c <= 57 ? 1 : c >= 65 && c <= 90 ? 2 : c >= 97 && c <= 122 ? 3 : 0
}

/** a e i o u y, either case: what a word of three letters or more holds and a random run of them often does not. */
function vowelAt(s: string, i: number): boolean {
  return 'aeiouyAEIOUY'.includes(s[i])
}

function shapeOf(s: string): Shape {
  const sh: Shape = { alnum: 0, upper: 0, lower: 0, digit: 0, switches: 0, changes: 0 }
  let pieces = 0
  let prev = 0
  let i = 0
  while (i < s.length) {
    const k = kindAt(s, i)
    if (k === 0) {
      i++
      continue
    }
    const start = i
    if (k === 2) {
      let j = i
      while (j < s.length && kindAt(s, j) === 2) j++
      if (j < s.length && kindAt(s, j) === 3) {
        // Capitals then lower case: the last capital starts a word (`SHAAnd` is `SHA`, `And`).
        if (j - i > 1) j--
        else while (++j < s.length && kindAt(s, j) === 3);
      }
      i = j
    } else {
      while (i < s.length && kindAt(s, i) === k) i++
    }
    let word = k !== 1 && i - start >= 3
    let vowel = false
    for (let x = start; x < i; x++) {
      const kx = kindAt(s, x)
      sh.alnum++
      if (kx === 1) sh.digit++
      else if (kx === 2) sh.upper++
      else sh.lower++
      if (prev !== 0 && kx !== prev) sh.changes++
      prev = kx
      if (word && !vowel) vowel = vowelAt(s, x)
    }
    word = word && vowel
    if (pieces > 0 && !word) sh.switches++
    pieces++
  }
  return sh
}

/*
 * From what share of positions a stretch reads as random rather than as a
 * name, measured on random strings and on the identifiers of this
 * repository, its node_modules' typings and a real index's copy: in both
 * cases, charged by its pieces (`Shape.switches`), a random string of letters
 * and digits stands at 0.47 in the middle and above 0.26 nine times in ten
 * at 20 characters; a name with numbers in it (`uniformMatrix2x3fv`,
 * `writeBigUInt64BE`, `pbeWithSHAAnd40BitRC2CBC`) at 0.24 or under. In one
 * case, by its changes (`Shape.changes`), a random string of lower-case
 * letters and digits stands near 0.4, and one case with digits glued into 16
 * characters with no `_` or `-` is no name's way of writing itself.
 */
const MIXED_RATE = 0.26
/**
 * From 24 characters on, a longer stretch says more: random ones stand above
 * 0.217 ninety-nine times in a hundred there, and of every mixed-case stretch
 * that long in this repository, its typings and a real index's copy, all under
 * 0.26 were ids or blobs (`toolu_` ids, SSH public keys, cuids, base64) but
 * two names, at 0.174 and 0.167 (`pbeWithSHAAnd40BitRC2CBC`,
 * `convertIPv4MappedIPv6ToIPv4`).
 */
const MIXED_RATE_LONG = 0.2
const MIXED_LONG = 24
const ONE_CASE_RATE = 0.2

/** Letters and digits in a stretch, at least, before it is judged. */
const STRETCH_MIN = 16

/*
 * A segment (between `_ + = -`) that is plainly part of a name: a word in one
 * case or capitalised, a number, a word and a number (`windows11`, `R9700`,
 * `2x`, `16px`), one number between two words of one case (`s3bucket`, a
 * model's `ASTH24KMTE`), or a compact date-time (`20260901T080513Z`).
 */
const WORD = '(?:[A-Z]?[a-z]+|[A-Z]+)'
const PLAIN = new RegExp(`^(?:${WORD}|[0-9]+|${WORD}[0-9]+|[0-9]+${WORD}|[a-z]+[0-9]+[a-z]+|[A-Z]+[0-9]+[A-Z]+|[0-9]{8}[Tt][0-9]{4,15}[Zz]?)$`)

/**
 * A segment of words alone, run together: `VPAUAggregateAudioDevice`,
 * `getServerSideProps`. A name's, like `PLAIN` — from 8 letters, as a short
 * random one (`xyZab`) reads as two words as easily.
 */
function nameWords(seg: string): boolean {
  if (seg.length < 8 || /[^A-Za-z]/.test(seg)) return false
  return shapeOf(seg).switches === 0
}

/** A stretch of a run's segments that are not plain, joined: random enough to be a key? */
function randomStretch(s: string): boolean {
  if (s.length < STRETCH_MIN) return false
  const sh = shapeOf(s)
  if (sh.digit === 0 || sh.upper + sh.lower === 0) return false
  if (sh.lower === 0 || sh.upper === 0) return sh.changes / (sh.alnum - 1) >= ONE_CASE_RATE
  return sh.switches / (sh.alnum - 1) >= (sh.alnum >= MIXED_LONG ? MIXED_RATE_LONG : MIXED_RATE)
}

/**
 * A run of token characters that is shaped like a key: `KEY_SHAPED_MIN` or
 * longer, with a stretch in it that is random. Its UUIDs are left out first
 * (`codex-clipboard-<uuid>`), and a git commit's full id is left whole. It is
 * then cut at `_ + = -` into segments (an `=` always ends a stretch); the
 * plain ones (`PLAIN`, `nameWords`) are a name's, so
 * `lena-full-audit-wf_3cf08d0a-e2b` is a name holding an 11-character id and
 * `protech_windows11_usb_labels_150x100mm` a file's. Each stretch of the others
 * in a row, joined (a base64url key cut by its own `-` and `_` is one stretch),
 * is judged by `randomStretch`: 16 letters and digits or more, a letter and a
 * digit among them, and random at `MIXED_RATE` in both cases (`MIXED_RATE_LONG`
 * from 24) or `ONE_CASE_RATE` in one. 32+ hex anywhere in it is taken
 * whatever its rate.
 */
export function keyShapedRun(run: string): boolean {
  let end = run.length
  while (end > 0 && run.charCodeAt(end - 1) === 61) end--
  let core = end === run.length ? run : run.slice(0, end)
  if (core.length < KEY_SHAPED_MIN) return false
  if (GIT_SHA.test(core)) return false
  if (core.length >= 36 && core.includes('-')) core = core.replace(UUID, '-')
  let stretch = ''
  // An `=` always ends a stretch: `u=3COFV…` is a name and its value, each judged on its own.
  for (const seg of core.split(/[_+-]+|(=+)/)) {
    if (seg === undefined) continue
    if (seg.length >= 32 && HEX.test(seg) && /[0-9]/.test(seg) && /[a-fA-F]/.test(seg)) return true
    // One or two letters between separators part no name's words (`a_9xQ…_aa_Q…`): they stay in the stretch.
    if (seg && seg[0] !== '=' && ((!PLAIN.test(seg) && !nameWords(seg)) || (seg.length <= 2 && !/[0-9]/.test(seg)))) {
      stretch += seg
      continue
    }
    if (randomStretch(stretch)) return true
    stretch = ''
  }
  return randomStretch(stretch)
}

/**
 * Where a text was cut, at either end: a search snippet's `…` (FTS cuts at
 * any word, so a snippet may open in the middle of a key, past its `-`, and
 * close on its first half). A run against a cut end may be the part of a
 * longer one, so it is judged as a search word is (`keyShapedTerm`, 8+).
 */
export interface KeyShapedCut {
  start: boolean
  end: boolean
}

/** A run against a cut end: what the cut left of a key is judged as a key's opening would be. */
function keyShapedPart(run: string): boolean {
  if (keyShapedRun(run)) return true
  for (const w of run.match(QUERY_WORD) ?? []) if (keyShapedTerm(w)) return true
  return false
}

/**
 * A run glued by a `/` to a run that was taken: a base64 key's other pieces
 * (`Ssyz1Ya/<the rest>`: 47 in 100 random 40-character base64 keys hold a
 * `/`). Taken too when one of its segments of 4 or more is random by the
 * stretch's own measures, whatever its length: a path's `Users`, `v2`,
 * `node_modules` and `miniflare-D1DatabaseObject` beside a hash stay.
 */
function slashPiece(run: string): boolean {
  for (const seg of run.split(/[_+=-]+/)) {
    if (seg.length < 4 || PLAIN.test(seg) || nameWords(seg) || !/[A-Za-z]/.test(seg)) continue
    const sh = shapeOf(seg)
    if (sh.upper > 0 && sh.lower > 0 ? sh.switches / (sh.alnum - 1) >= MIXED_RATE : sh.digit > 0 && sh.changes / (sh.alnum - 1) >= ONE_CASE_RATE) return true
  }
  return false
}

/**
 * The `[start, end)` of every run `redactKeyShaped` takes from `text`, in
 * order. `cut` says which ends were cut (`KeyShapedCut`): the run touching
 * that end, past any `…` and spaces, is judged as a part (`keyShapedPart`).
 * A taken run's neighbours across a single `/` are judged as its pieces
 * (`slashPiece`), and theirs in turn.
 */
export function keyShapedSpans(text: string, cut: KeyShapedCut = { start: false, end: false }): [number, number][] {
  if (text.length < 8) return []
  let first = 0
  if (cut.start) while (first < text.length && (text[first] === '…' || text[first] === ' ' || text[first] === '.')) first++
  let last = text.length
  if (cut.end) while (last > 0 && (text[last - 1] === '…' || text[last - 1] === ' ' || text[last - 1] === '.')) last--
  const runs: { at: number; run: string; taken: boolean }[] = []
  for (const m of text.matchAll(RUN)) {
    const at = m.index ?? 0
    const run = m[0]
    const edge = (cut.start && at === first) || (cut.end && at + run.length === last)
    // 40 hex right before an `@` is a URL's user — an old-style GitHub token in a clone URL — not a commit.
    const userinfo = text[at + run.length] === '@' && GIT_SHA.test(run)
    runs.push({ at, run, taken: userinfo || (edge ? keyShapedPart(run) : keyShapedRun(run)) })
  }
  // Glued by one `/` to a taken run, either way along the chain: two passes carry it as far as it goes.
  const glued = (a: { at: number; run: string }, b: { at: number }): boolean => b.at === a.at + a.run.length + 1 && text[b.at - 1] === '/'
  for (let i = 1; i < runs.length; i++) if (runs[i - 1].taken && !runs[i].taken && glued(runs[i - 1], runs[i]) && slashPiece(runs[i].run)) runs[i].taken = true
  for (let i = runs.length - 2; i >= 0; i--) if (runs[i + 1].taken && !runs[i].taken && glued(runs[i], runs[i + 1]) && slashPiece(runs[i].run)) runs[i].taken = true
  const out: [number, number][] = []
  for (const { at, run, taken } of runs) {
    if (!taken) continue
    const head = NAME_HEAD.exec(run)
    out.push([at + (head && !keyShapedPart(head[1]) ? head[0].length : 0), at + run.length])
  }
  return out
}

/** A name and its `=` at a run's start (`DB_PASSWORD=`, `--token=`), kept before a value that is taken. */
const NAME_HEAD = /^([A-Za-z0-9_+-]+)=(?=[A-Za-z0-9_+-])/

/**
 * `text` with every key-shaped run (`keyShapedRun`) made `[redacted]`, and a
 * run against an end `cut` names judged as a part (`keyShapedSpans`). Linear:
 * one scan for runs, each judged in a walk of its own characters.
 */
export function redactKeyShaped(text: string, cut?: KeyShapedCut): string {
  const spans = keyShapedSpans(text, cut)
  if (spans.length === 0) return text
  let out = ''
  let at = 0
  for (const [a, b] of spans) {
    out += text.slice(at, a) + KEY_SHAPED_MARK
    at = b
  }
  return out + text.slice(at)
}

/* ------------------------------------------------------- what a guest may ask */

/** A query word as FTS's tokenizer reads it (`unicode61`): letters and digits, in any script; `_` and `-` part words. */
const QUERY_WORD = /[\p{L}\p{N}]+/gu

/**
 * One word of a search, judged more loosely than a shared text's runs (a
 * whole word of 8 characters may be a key's opening): 8 letters and digits or
 * more, ASCII, holding letters AND digits, and either three changes between a
 * letter and a digit (`a1b2`), both cases charged as a random string's
 * (`MIXED_RATE`; `useState2` is a name, `Ab3dEfGh` is not), or 16+ hex.
 *
 * FTS matches each word as a PREFIX of a word stored, so a guest that may ask
 * "is there a word starting `ab3de`?" one character more at a time reads a
 * key no pattern knows off the answers alone. Here it may ask only until the
 * key's opening turns key-like: its third change between a letter and a digit,
 * its eighth character if it is hex. Its case is no help to it, as FTS folds
 * case; both cases count only against a key pasted whole. A 7-character git
 * short id (`9ea4f06`) is under the length and stays searchable; a longer
 * prefix of one is refused once it is 16 or has changed between letter and
 * digit three times, and so is a UUID whose first group has.
 */
export function keyShapedTerm(word: string): boolean {
  if (word.length < 8 || /[^0-9A-Za-z]/.test(word)) return false
  let letters = 0
  let digits = 0
  let alternations = 0
  let prev = 0
  for (let i = 0; i < word.length; i++) {
    const k = kindAt(word, i) === 1 ? 1 : 2
    if (k === 1) digits++
    else letters++
    if (prev !== 0 && k !== prev) alternations++
    prev = k
  }
  if (letters === 0 || digits === 0) return false
  if (alternations >= 3 || /^[0-9a-fA-F]{16,}$/.test(word)) return true
  const sh = shapeOf(word)
  return sh.upper > 0 && sh.lower > 0 && sh.switches / (sh.alnum - 1) >= MIXED_RATE
}

/**
 * Whether a guest's search looks like a key or a code (`query-key-shaped`):
 * any of its words is key-shaped by `keyShapedTerm`, or any run of its token
 * characters is one a shared text would lose (`keyShapedRun`: a key pasted
 * with its `-` and `_`). The host refuses it before the index is asked.
 */
export function keyShapedQuery(query: string): boolean {
  for (const w of query.match(QUERY_WORD) ?? []) if (keyShapedTerm(w)) return true
  for (const r of query.match(RUN) ?? []) if (keyShapedRun(r)) return true
  return false
}
