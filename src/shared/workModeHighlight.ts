/**
 * Work mode's syntax highlighter: a small lexer per grammar, run one line at a
 * time with the state at the line's start carried in (a block comment, a
 * template literal, a tag left open). No dependency: none is in the tree, and
 * the lexer has to run per line on every keystroke batch, tokenise partial
 * lines, and say where each line starts and ends (the skip rule in
 * workModeDoc.ts reads that).
 *
 * Two promises the suite holds:
 * - **Lossless.** The tokens' text joined is the line, every time, and no
 *   token is empty. File text is untrusted, so the renderer draws tokens as
 *   React text only.
 * - **Linear.** Every rule is a sticky regex with no nested quantifier and no
 *   ambiguous alternation, or an `indexOf` scan; a scan that can fail is
 *   bounded or remembered, so an adversarial 4,000-character line costs
 *   milliseconds.
 *
 * Pure, and compiled by both tsconfigs (gotcha 27).
 */
import type { Grammar } from './workMode.ts'

export type { Grammar }

export type TokenKind =
  | 'text'
  | 'keyword'
  | 'string'
  | 'number'
  | 'constant'
  | 'comment'
  | 'function'
  | 'type'
  | 'property'
  | 'tag'
  | 'attr'
  | 'punct'
  | 'operator'
  | 'variable'
  | 'regex'

export interface Token {
  kind: TokenKind
  text: string
}

export interface LexState {
  mode: string
  /** Brace depth: a style sheet's rule nesting, or a JSX attribute's `{…}`. */
  depth?: number
  /** The mode a comment or a string spanning lines goes back to. */
  ret?: string
  /** What closes a multi-line string: a quote, a triple quote, a long bracket. */
  quote?: string
  /** An HTML tag's name while its attributes run on. */
  tag?: string
  /** The language inside `<script>` or `<style>` or a Markdown fence, its own state, and its dialect. */
  embed?: { grammar: Grammar; state: LexState; lang?: string }
}

export function plainState(grammar: Grammar): LexState {
  if (grammar === 'css') return { mode: 'code', depth: 0 }
  if (grammar === 'html') return { mode: 'text' }
  return { mode: 'code' }
}

/** Whether a state is the grammar's plain one: no comment, string, template or tag spans into it (a style sheet's depth aside). */
export function isPlainState(grammar: Grammar, state: LexState): boolean {
  return state.mode === plainState(grammar).mode && !state.embed && state.ret === undefined && state.quote === undefined
}

export function sameState(a: LexState, b: LexState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ------------------------------------------------------------- helpers */

/** Tokens are merged only where it changes nothing a reader sees; punctuation stays one token per run for the skip rule. */
const MERGES: ReadonlySet<TokenKind> = new Set(['text', 'comment', 'string'])

function pushTo(out: Token[], kind: TokenKind, text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind && MERGES.has(kind)) last.text += text
  else out.push({ kind, text })
}

function stick(re: RegExp, line: string, pos: number): string | null {
  re.lastIndex = pos
  const m = re.exec(line)
  return m && m[0].length > 0 ? m[0] : null
}

/** The index just past a quote closing at or after `from`, skipping backslash escapes; -1 when the line has none. */
function closeQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') {
      i++
      continue
    }
    if (line.startsWith(quote, i)) return i + quote.length
  }
  return -1
}

const WS = /[ \t]+/y
const IDENT = /[A-Za-z_$][\w$]*/y
const NUMBER = /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y
const CNUMBER =
  /0[xX][0-9a-fA-F_]+[uUlL]*|0[bB][01_]+[uUlL]*|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[fFdDlLuUmM]*(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64)?/y
const PUNCT = /[{}()[\];,.]/y
const OPERATOR = /[+\-*/%=<>!&|^~?:@]+/y
/** A regex literal, bounded so a `/` that opens none costs at most a few hundred characters. */
const REGEX = /\/(?![*/])(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.){0,120}\]){1,240}\/[dgimsuyv]{0,8}/y

const set = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean))

const JS_KEYWORDS = set(`break case catch class const continue debugger default delete do else export extends finally for
  function if import in instanceof let new of return super switch this throw try typeof var void while with yield async
  await static as from type interface enum implements private protected public readonly declare abstract keyof satisfies
  override`)
const JS_CONSTANTS = set('true false null undefined NaN Infinity')
const REGEX_AFTER = set('return typeof case do else in instanceof new delete void throw yield await of')

/** Whether what came before lets a `/` start a regex (or a `<` a JSX tag): the start of an expression. */
function exprStart(prev: Token | null): boolean {
  if (!prev) return true
  if (prev.kind === 'keyword') return REGEX_AFTER.has(prev.text)
  if (prev.kind === 'operator') return true
  if (prev.kind === 'punct') return !/[)\]}]$/.test(prev.text)
  return false
}

/** Classify an identifier by what it is and what is around it. */
function classify(
  word: string,
  line: string,
  end: number,
  prev: Token | null,
  keywords: ReadonlySet<string>,
  constants: ReadonlySet<string>,
  types?: ReadonlySet<string>
): TokenKind {
  // After a `.` it is a member, whatever its name (`.delete()`, `.default`).
  if (prev && prev.kind === 'punct' && prev.text === '.') return nextIsCall(line, end) ? 'function' : 'property'
  if (keywords.has(word)) return 'keyword'
  if (constants.has(word)) return 'constant'
  if (types?.has(word)) return 'type'
  if (nextIsCall(line, end)) return 'function'
  if (/^[A-Z]/.test(word)) return word.length > 1 && word === word.toUpperCase() && /[A-Z]{2}/.test(word) ? 'constant' : 'type'
  return 'text'
}

const CALL = /[ \t]{0,4}\(/y
function nextIsCall(line: string, end: number): boolean {
  CALL.lastIndex = end
  return CALL.test(line)
}

/* ------------------------------------------------------------ JS / JSX */

/**
 * A `<` that opens an element among JSX children (`bold <b>x</b>`): a space,
 * `>` or `}` before it and a lower-case name after it that ends at `>`, a
 * space or `/`. A generic (`useState<string>`) has a name glued before it, and
 * a comparison a space after it, so neither reads as a tag.
 */
const CHILD_TAG = /<[a-z][\w.:-]*(?=[\s>/])/y
function childTag(line: string, pos: number): boolean {
  const before = line[pos - 1]
  if (before !== undefined && !/[\s>}]/.test(before)) return false
  CHILD_TAG.lastIndex = pos
  return CHILD_TAG.test(line)
}

const JSX_ATTR = /[A-Za-z_][\w:.-]*/y
const JSX_TAG = /[A-Za-z][\w.:-]*/y

function lexJs(line: string, start: LexState, jsx: boolean, out: Token[]): LexState {
  let mode = start.mode
  let depth = start.depth ?? 0
  let ret = start.ret
  const n = line.length
  let pos = 0
  let prev: Token | null = null
  const unclosed = new Set<string>()
  const push = (kind: TokenKind, text: string): void => {
    pushTo(out, kind, text)
    if (kind !== 'text' && kind !== 'comment') prev = { kind, text }
    else if (kind === 'text' && text.trim()) prev = { kind, text }
  }
  const back = (): void => {
    mode = ret ?? 'code'
    ret = undefined
  }
  while (pos < n) {
    if (mode === 'block') {
      const end = line.indexOf('*/', pos)
      if (end < 0) {
        pushTo(out, 'comment', line.slice(pos))
        pos = n
        break
      }
      pushTo(out, 'comment', line.slice(pos, end + 2))
      pos = end + 2
      back()
      continue
    }
    if (mode === 'tpl') {
      const end = closeQuote(line, pos, '`')
      if (end < 0) {
        pushTo(out, 'string', line.slice(pos))
        pos = n
        break
      }
      push('string', line.slice(pos, end))
      pos = end
      back()
      continue
    }
    if (mode === 'jsxTag') {
      const ws = stick(WS, line, pos)
      if (ws) {
        pushTo(out, 'text', ws)
        pos += ws.length
        continue
      }
      if (line.startsWith('/>', pos)) {
        push('punct', '/>')
        pos += 2
        mode = 'code'
        continue
      }
      const c = line[pos]
      if (c === '>') {
        push('punct', '>')
        pos++
        mode = 'code'
        continue
      }
      if (c === '{') {
        push('punct', '{')
        pos++
        mode = 'jsxExpr'
        depth = 1
        continue
      }
      if (c === '"' || c === "'") {
        const end = closeQuote(line, pos + 1, c)
        const stop = end < 0 ? n : end
        push('string', line.slice(pos, stop))
        pos = stop
        continue
      }
      const attr = stick(JSX_ATTR, line, pos)
      if (attr) {
        push('attr', attr)
        pos += attr.length
        continue
      }
      push(c === '=' ? 'punct' : 'text', c)
      pos++
      continue
    }
    // 'code', or 'jsxExpr' (code inside a JSX attribute's braces)
    const ws = stick(WS, line, pos)
    if (ws) {
      pushTo(out, 'text', ws)
      pos += ws.length
      continue
    }
    const c = line[pos]
    if (c === '/' && line[pos + 1] === '/') {
      pushTo(out, 'comment', line.slice(pos))
      pos = n
      break
    }
    if (c === '/' && line[pos + 1] === '*') {
      ret = mode === 'jsxExpr' ? 'jsxExpr' : undefined
      mode = 'block'
      pushTo(out, 'comment', '/*')
      pos += 2
      continue
    }
    if (c === '`') {
      ret = mode === 'jsxExpr' ? 'jsxExpr' : undefined
      mode = 'tpl'
      pushTo(out, 'string', '`')
      pos++
      continue
    }
    if (c === '"' || c === "'") {
      if (!unclosed.has(c)) {
        const end = closeQuote(line, pos + 1, c)
        if (end >= 0) {
          push('string', line.slice(pos, end))
          pos = end
          continue
        }
        unclosed.add(c)
        if (!jsx) {
          push('string', line.slice(pos))
          pos = n
          break
        }
      }
      // JSX text ("it's") holds a lone quote; it is text, not a string to the end of the line.
      push('text', c)
      pos++
      continue
    }
    if (jsx && c === '<' && /[A-Za-z/>]/.test(line[pos + 1] ?? '') && (line[pos + 1] === '/' || exprStart(prev) || childTag(line, pos))) {
      const closing = line[pos + 1] === '/'
      push('punct', closing ? '</' : '<')
      pos += closing ? 2 : 1
      const name = stick(JSX_TAG, line, pos)
      if (name) {
        push(/^[A-Z]/.test(name) ? 'type' : 'tag', name)
        pos += name.length
      }
      if (line[pos] === '>') {
        push('punct', '>')
        pos++
      } else mode = 'jsxTag'
      continue
    }
    if (c === '/' && exprStart(prev)) {
      const re = stick(REGEX, line, pos)
      if (re) {
        push('regex', re)
        pos += re.length
        continue
      }
    }
    const num = /[0-9.]/.test(c) ? stick(NUMBER, line, pos) : null
    if (num && num !== '.') {
      push('number', num)
      pos += num.length
      continue
    }
    const word = stick(IDENT, line, pos)
    if (word) {
      push(classify(word, line, pos + word.length, prev, JS_KEYWORDS, JS_CONSTANTS), word)
      pos += word.length
      continue
    }
    if (c === '{' || c === '}') {
      push('punct', c)
      pos++
      if (mode === 'jsxExpr') {
        depth += c === '{' ? 1 : -1
        if (depth <= 0) {
          mode = 'jsxTag'
          depth = 0
        }
      }
      continue
    }
    const p = stick(PUNCT, line, pos)
    if (p) {
      push('punct', p)
      pos += p.length
      continue
    }
    const op = stick(OPERATOR, line, pos)
    if (op) {
      push('operator', op)
      pos += op.length
      continue
    }
    pushTo(out, 'text', c)
    pos++
  }
  const end: LexState = { mode }
  if (mode === 'jsxExpr') end.depth = depth
  if (ret !== undefined && (mode === 'block' || mode === 'tpl')) {
    end.ret = ret
    if (ret === 'jsxExpr') end.depth = depth
  }
  return end
}

/* -------------------------------------------------------------- C-like */

interface CLang {
  keywords: ReadonlySet<string>
  types: ReadonlySet<string>
  constants: ReadonlySet<string>
  /** A `#` starts a preprocessor line (C, C++, C#), a comment (PHP), or neither. */
  hash: 'pre' | 'comment' | null
  /** Backtick raw strings across lines (Go). */
  raw: boolean
  /** `"""` strings across lines (Kotlin, Swift, Java, Scala, Dart, C#). */
  triple: boolean
  /** `'a` is a lifetime (Rust). */
  lifetimes: boolean
  /** `$name` is a variable (PHP). */
  dollar: boolean
  /** `name!(` is a macro call (Rust). */
  macros: boolean
}

const C_TYPES = set('void char short int long float double signed unsigned bool size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t auto')
const CLANGS: Record<string, CLang> = {
  c: {
    keywords: set('break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while'),
    types: C_TYPES, constants: set('NULL true false'), hash: 'pre', raw: false, triple: false, lifetimes: false, dollar: false, macros: false
  },
  cpp: {
    keywords: set(`break case catch class const constexpr consteval continue co_await co_return decltype default delete do else enum
      explicit export extern for friend goto if inline mutable namespace new noexcept operator override private protected public
      return sizeof static static_assert struct switch template this throw try typedef typename union using virtual volatile while final`),
    types: set('void char short int long float double signed unsigned bool size_t auto string vector map optional'),
    constants: set('nullptr NULL true false'), hash: 'pre', raw: false, triple: false, lifetimes: false, dollar: false, macros: false
  },
  cs: {
    keywords: set(`abstract as async await base break case catch checked class const continue default delegate do else enum event
      explicit extern finally fixed for foreach get if implicit in interface internal is lock namespace new operator out override
      params private protected public readonly record ref return sealed set sizeof static struct switch this throw try typeof
      unchecked unsafe using var virtual void volatile when where while yield init required`),
    types: set('bool byte char decimal double float int long object sbyte short string uint ulong ushort dynamic'),
    constants: set('null true false'), hash: 'pre', raw: false, triple: true, lifetimes: false, dollar: false, macros: false
  },
  java: {
    keywords: set(`abstract assert break case catch class const continue default do else enum extends final finally for goto if
      implements import instanceof interface native new package private protected public record return sealed permits static
      strictfp super switch synchronized this throw throws transient try var void volatile while yield`),
    types: set('boolean byte char double float int long short String Object'),
    constants: set('null true false'), hash: null, raw: false, triple: true, lifetimes: false, dollar: false, macros: false
  },
  kotlin: {
    keywords: set(`abstract annotation as break by catch class companion const constructor continue crossinline data do else enum
      expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline
      object open operator out override package private protected public reified return sealed set super suspend tailrec this
      throw try typealias val var vararg when where while`),
    types: set('Int Long Short Byte Double Float Boolean Char String Unit Any Nothing List Map Set'),
    constants: set('null true false'), hash: null, raw: false, triple: true, lifetimes: false, dollar: false, macros: false
  },
  swift: {
    keywords: set(`actor associatedtype async await break case catch class continue default defer deinit do else enum extension
      fallthrough fileprivate final for func guard if import in init inout internal is let mutating nonisolated open operator
      override private protocol public repeat rethrows return self Self some any static struct subscript super switch throw
      throws try typealias var weak where while lazy`),
    types: set('Int Double Float Bool String Character Array Dictionary Set Void Optional'),
    constants: set('nil true false'), hash: null, raw: false, triple: true, lifetimes: false, dollar: false, macros: false
  },
  dart: {
    keywords: set(`abstract as assert async await base break case catch class const continue covariant default deferred do dynamic
      else enum export extends extension external factory final finally for get hide if implements import in interface is late
      library mixin new on operator part required rethrow return sealed set show static super switch sync this throw try typedef
      var void when while with yield`),
    types: set('int double num bool String List Map Set Future Stream Object'),
    constants: set('null true false'), hash: null, raw: false, triple: true, lifetimes: false, dollar: false, macros: false
  },
  scala: {
    keywords: set(`abstract case catch class def do else enum export extends final finally for forSome given if implicit import
      lazy match new object override package private protected return sealed super then this throw trait try type using val var
      while with yield`),
    types: set('Int Long Double Float Boolean Char String Unit Any Nothing List Map Option Seq'),
    constants: set('null true false None Nil'), hash: null, raw: false, triple: true, lifetimes: false, dollar: false, macros: false
  },
  go: {
    keywords: set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
    types: set('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any'),
    constants: set('nil true false iota'), hash: null, raw: true, triple: false, lifetimes: false, dollar: false, macros: false
  },
  rust: {
    keywords: set(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub
      ref return self Self static struct super trait type unsafe use where while`),
    types: set('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box'),
    constants: set('true false None Some Ok Err'), hash: null, raw: false, triple: false, lifetimes: true, dollar: false, macros: true
  },
  php: {
    keywords: set(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif
      empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto
      if implements include include_once instanceof insteadof interface isset list match namespace new or print private
      protected public readonly require require_once return static switch throw trait try unset use var while yield`),
    types: set('int float bool string void mixed never object iterable'),
    constants: set('null true false NULL TRUE FALSE'), hash: 'comment', raw: false, triple: false, lifetimes: false, dollar: true, macros: false
  }
}

const PREPROCESSOR = /#[ \t]*[A-Za-z_]+/y
const ANNOTATION = /@[A-Za-z_][\w.]*/y
const LIFETIME = /'[A-Za-z_]\w*(?!')/y
const CHAR_LIT = /'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.))'/y
const DOLLAR_VAR = /\$[A-Za-z_]\w*/y

function lexClike(line: string, start: LexState, langName: string, out: Token[]): LexState {
  const lang = CLANGS[langName] ?? CLANGS.c
  let mode = start.mode
  let quote = start.quote
  const n = line.length
  let pos = 0
  let prev: Token | null = null
  const push = (kind: TokenKind, text: string): void => {
    pushTo(out, kind, text)
    if (kind !== 'text' && kind !== 'comment') prev = { kind, text }
  }
  while (pos < n) {
    if (mode === 'block') {
      const end = line.indexOf('*/', pos)
      if (end < 0) {
        pushTo(out, 'comment', line.slice(pos))
        pos = n
        break
      }
      pushTo(out, 'comment', line.slice(pos, end + 2))
      pos = end + 2
      mode = 'code'
      continue
    }
    if (mode === 'string') {
      const q = quote ?? '"'
      const end = q === '`' ? line.indexOf('`', pos) : closeQuote(line, pos, q)
      if (end < 0) {
        pushTo(out, 'string', line.slice(pos))
        pos = n
        break
      }
      const stop = q === '`' ? end + 1 : end
      push('string', line.slice(pos, stop))
      pos = stop
      mode = 'code'
      quote = undefined
      continue
    }
    const ws = stick(WS, line, pos)
    if (ws) {
      pushTo(out, 'text', ws)
      pos += ws.length
      continue
    }
    const c = line[pos]
    if (c === '/' && line[pos + 1] === '/') {
      pushTo(out, 'comment', line.slice(pos))
      pos = n
      break
    }
    if (c === '/' && line[pos + 1] === '*') {
      mode = 'block'
      pushTo(out, 'comment', '/*')
      pos += 2
      continue
    }
    if (c === '#' && lang.hash === 'comment') {
      pushTo(out, 'comment', line.slice(pos))
      pos = n
      break
    }
    if (c === '#' && lang.hash === 'pre' && !line.slice(0, pos).trim()) {
      const pre = stick(PREPROCESSOR, line, pos)
      if (pre) {
        push('keyword', pre)
        pos += pre.length
        const rest = /^[ \t]*<[^>\n]{0,200}>/.exec(line.slice(pos))
        if (rest) {
          const lead = rest[0].length - rest[0].trimStart().length
          pushTo(out, 'text', rest[0].slice(0, lead))
          push('string', rest[0].slice(lead))
          pos += rest[0].length
        }
        continue
      }
    }
    if (c === '<' && line.startsWith('<?php', pos)) {
      push('keyword', '<?php')
      pos += 5
      continue
    }
    if (lang.triple && line.startsWith('"""', pos)) {
      const end = line.indexOf('"""', pos + 3)
      if (end < 0) {
        pushTo(out, 'string', line.slice(pos))
        mode = 'string'
        quote = '"""'
        pos = n
        break
      }
      push('string', line.slice(pos, end + 3))
      pos = end + 3
      continue
    }
    if (c === '`' && lang.raw) {
      const end = line.indexOf('`', pos + 1)
      if (end < 0) {
        pushTo(out, 'string', line.slice(pos))
        mode = 'string'
        quote = '`'
        pos = n
        break
      }
      push('string', line.slice(pos, end + 1))
      pos = end + 1
      continue
    }
    if (c === '"') {
      const end = closeQuote(line, pos + 1, '"')
      const stop = end < 0 ? n : end
      push('string', line.slice(pos, stop))
      pos = stop
      continue
    }
    if (c === "'") {
      if (lang.lifetimes) {
        const ch = stick(CHAR_LIT, line, pos)
        if (ch) {
          push('string', ch)
          pos += ch.length
          continue
        }
        const life = stick(LIFETIME, line, pos)
        if (life) {
          push('type', life)
          pos += life.length
          continue
        }
        push('text', c)
        pos++
        continue
      }
      const end = closeQuote(line, pos + 1, "'")
      const stop = end < 0 ? n : end
      push('string', line.slice(pos, stop))
      pos = stop
      continue
    }
    if (c === '$' && lang.dollar) {
      const v = stick(DOLLAR_VAR, line, pos)
      if (v) {
        push('variable', v)
        pos += v.length
        continue
      }
    }
    if (c === '@' && !lang.dollar) {
      const a = stick(ANNOTATION, line, pos)
      if (a) {
        push('function', a)
        pos += a.length
        continue
      }
    }
    const num = /[0-9.]/.test(c) ? stick(CNUMBER, line, pos) : null
    if (num && num !== '.') {
      push('number', num)
      pos += num.length
      continue
    }
    const word = stick(IDENT, line, pos)
    if (word) {
      const end = pos + word.length
      const kind = lang.macros && line[end] === '!' && line[end + 1] !== '=' ? 'function' : classify(word, line, end, prev, lang.keywords, lang.constants, lang.types)
      push(kind, word)
      pos = end
      continue
    }
    const p = stick(PUNCT, line, pos)
    if (p) {
      push('punct', p)
      pos += p.length
      continue
    }
    const op = stick(OPERATOR, line, pos)
    if (op) {
      push('operator', op)
      pos += op.length
      continue
    }
    pushTo(out, 'text', c)
    pos++
  }
  return mode === 'code' ? { mode } : { mode, ...(quote !== undefined ? { quote } : {}) }
}

/* -------------------------------------------------------------- Python */

const PY_KEYWORDS = set(`and as assert async await break class continue def del elif else except finally for from global if import in
  is lambda nonlocal not or pass raise return try while with yield match case`)
const PY_CONSTANTS = set('True False None NotImplemented Ellipsis')
const PY_TYPES = set('int float str bytes bool list dict set tuple object type Exception')
const PY_PREFIX = /[rRbBuUfF]{1,2}(?=['"])/y
const DECORATOR = /@[A-Za-z_][\w.]*/y

function lexPython(line: string, start: LexState, out: Token[]): LexState {
  let mode = start.mode
  let quote = start.quote
  const n = line.length
  let pos = 0
  let prev: Token | null = null
  let after: string | null = null
  const push = (kind: TokenKind, text: string): void => {
    pushTo(out, kind, text)
    if (kind !== 'text' && kind !== 'comment') prev = { kind, text }
  }
  while (pos < n) {
    if (mode === 'triple') {
      const q = quote ?? '"""'
      const end = line.indexOf(q, pos)
      if (end < 0) {
        pushTo(out, 'string', line.slice(pos))
        pos = n
        break
      }
      push('string', line.slice(pos, end + 3))
      pos = end + 3
      mode = 'code'
      quote = undefined
      continue
    }
    const ws = stick(WS, line, pos)
    if (ws) {
      pushTo(out, 'text', ws)
      pos += ws.length
      continue
    }
    const c = line[pos]
    if (c === '#') {
      pushTo(out, 'comment', line.slice(pos))
      pos = n
      break
    }
    const prefix = stick(PY_PREFIX, line, pos) ?? ''
    const q0 = line[pos + prefix.length]
    if (q0 === '"' || q0 === "'") {
      const open = pos + prefix.length
      if (line.startsWith(q0.repeat(3), open)) {
        const end = line.indexOf(q0.repeat(3), open + 3)
        if (end < 0) {
          pushTo(out, 'string', line.slice(pos))
          mode = 'triple'
          quote = q0.repeat(3)
          pos = n
          break
        }
        push('string', line.slice(pos, end + 3))
        pos = end + 3
        continue
      }
      const end = closeQuote(line, open + 1, q0)
      const stop = end < 0 ? n : end
      push('string', line.slice(pos, stop))
      pos = stop
      continue
    }
    if (c === '@' && (!prev || (prev as Token).kind !== 'text')) {
      const d = stick(DECORATOR, line, pos)
      if (d && !line.slice(0, pos).trim()) {
        push('function', d)
        pos += d.length
        continue
      }
    }
    const num = /[0-9.]/.test(c) ? stick(CNUMBER, line, pos) : null
    if (num && num !== '.') {
      push('number', num)
      pos += num.length
      continue
    }
    const word = stick(IDENT, line, pos)
    if (word) {
      let kind: TokenKind
      if (after === 'def') kind = 'function'
      else if (after === 'class') kind = 'type'
      else if (word === 'self' || word === 'cls') kind = 'variable'
      else kind = classify(word, line, pos + word.length, prev, PY_KEYWORDS, PY_CONSTANTS, PY_TYPES)
      after = word === 'def' || word === 'class' ? word : null
      push(kind, word)
      pos += word.length
      continue
    }
    after = null
    const p = stick(PUNCT, line, pos)
    if (p) {
      push('punct', p)
      pos += p.length
      continue
    }
    const op = stick(OPERATOR, line, pos)
    if (op) {
      push('operator', op)
      pos += op.length
      continue
    }
    pushTo(out, 'text', c)
    pos++
  }
  return mode === 'triple' ? { mode, quote: quote ?? '"""' } : { mode: 'code' }
}

/* -------------------------------------- shell, Ruby, Lua, Elixir, SQL */

interface ScriptLang {
  keywords: ReadonlySet<string>
  constants: ReadonlySet<string>
  types?: ReadonlySet<string>
  comment: '#' | '--'
  /** SQL's keywords are case-insensitive. */
  fold: boolean
  dollar: boolean
  /** `:atom` is a constant, `@x` a variable (Ruby, Elixir). */
  sigils: boolean
  /** `"""` heredocs across lines (Elixir). */
  triple: boolean
  /** `--[[ … ]]` comments and `[[ … ]]` strings across lines (Lua). */
  long: boolean
  /** `/* … *\/` comments across lines (SQL). */
  block: boolean
}

const SCRIPT_LANGS: Record<string, ScriptLang> = {
  sh: {
    keywords: set(`if then else elif fi for while until do done case esac function in select return local export readonly declare
      typeset unset shift exit break continue source alias trap set eval exec time`),
    constants: set('true false'), comment: '#', fold: false, dollar: true, sigils: false, triple: false, long: false, block: false
  },
  ruby: {
    keywords: set(`alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo
      rescue retry return self super then undef unless until when while yield require require_relative attr_reader
      attr_writer attr_accessor private protected public include extend raise lambda proc loop`),
    constants: set('nil true false'), comment: '#', fold: false, dollar: true, sigils: true, triple: false, long: false, block: false
  },
  lua: {
    keywords: set('and break do else elseif end for function goto if in local not or repeat return then until while'),
    constants: set('nil true false'), comment: '--', fold: false, dollar: false, sigils: false, triple: false, long: true, block: false
  },
  elixir: {
    keywords: set(`after alias and case catch cond def defp defmodule defstruct defimpl defprotocol defmacro do else end fn for if
      import in not or quote raise receive require rescue try unless unquote use when with`),
    constants: set('nil true false'), comment: '#', fold: false, dollar: false, sigils: true, triple: true, long: false, block: false
  },
  sql: {
    keywords: set(`select from where and or not insert into values update set delete create table index primary key foreign
      references join left right inner outer full cross on group by order having limit offset as distinct union all case when
      then else end null is in like ilike between exists drop alter add column default unique check constraint begin commit
      rollback transaction view with returning asc desc if replace trigger function procedure language grant revoke cascade`),
    constants: set('true false'),
    types: set('int integer bigint smallint text varchar char boolean bool date time timestamp timestamptz numeric decimal serial bigserial uuid json jsonb real float double blob'),
    comment: '--', fold: true, dollar: false, sigils: false, triple: false, long: false, block: true
  }
}

const SH_VAR = /\$(?:\{[^}\n]{0,200}\}?|[A-Za-z_]\w*|[0-9#?@*$!-])/y
const SYMBOL = /:[A-Za-z_]\w*[?!]?/y
const IVAR = /@@?[A-Za-z_]\w*/y
const GVAR = /\$[A-Za-z_]\w*/y
const SCRIPT_IDENT = /[A-Za-z_][\w]*[?!]?/y
const LONG_OPEN = /\[(=*)\[/y

function lexScript(line: string, start: LexState, langName: string, out: Token[]): LexState {
  const lang = SCRIPT_LANGS[langName] ?? SCRIPT_LANGS.sh
  let mode = start.mode
  let quote = start.quote
  const n = line.length
  let pos = 0
  let prev: Token | null = null
  let after: string | null = null
  const push = (kind: TokenKind, text: string): void => {
    pushTo(out, kind, text)
    if (kind !== 'text' && kind !== 'comment') prev = { kind, text }
  }
  // Ruby's =begin/=end, at the start of a line.
  if (langName === 'ruby') {
    if (mode === 'rdoc') {
      pushTo(out, 'comment', line)
      return line.startsWith('=end') ? { mode: 'code' } : { mode: 'rdoc' }
    }
    if (line.startsWith('=begin')) {
      pushTo(out, 'comment', line)
      return { mode: 'rdoc' }
    }
  }
  while (pos < n) {
    if (mode === 'longComment' || mode === 'longString' || mode === 'block' || mode === 'triple') {
      const close = mode === 'block' ? '*/' : (quote ?? ']]')
      const end = line.indexOf(close, pos)
      const kind: TokenKind = mode === 'longComment' || mode === 'block' ? 'comment' : 'string'
      if (end < 0) {
        pushTo(out, kind, line.slice(pos))
        pos = n
        break
      }
      pushTo(out, kind, line.slice(pos, end + close.length))
      if (kind === 'string') prev = { kind, text: close }
      pos = end + close.length
      mode = 'code'
      quote = undefined
      continue
    }
    const ws = stick(WS, line, pos)
    if (ws) {
      pushTo(out, 'text', ws)
      pos += ws.length
      continue
    }
    const c = line[pos]
    if (lang.comment === '--' && line.startsWith('--', pos)) {
      if (lang.long) {
        const open = stick(LONG_OPEN, line, pos + 2)
        if (open) {
          const close = ']' + '='.repeat(open.length - 2) + ']'
          const end = line.indexOf(close, pos + 2 + open.length)
          if (end < 0) {
            pushTo(out, 'comment', line.slice(pos))
            mode = 'longComment'
            quote = close
            pos = n
            break
          }
          pushTo(out, 'comment', line.slice(pos, end + close.length))
          pos = end + close.length
          continue
        }
      }
      pushTo(out, 'comment', line.slice(pos))
      pos = n
      break
    }
    if (lang.comment === '#' && c === '#' && (pos === 0 || /[ \t;]/.test(line[pos - 1]))) {
      pushTo(out, 'comment', line.slice(pos))
      pos = n
      break
    }
    if (lang.block && line.startsWith('/*', pos)) {
      mode = 'block'
      pushTo(out, 'comment', '/*')
      pos += 2
      continue
    }
    if (lang.long && c === '[') {
      const open = stick(LONG_OPEN, line, pos)
      if (open) {
        const close = ']' + '='.repeat(open.length - 2) + ']'
        const end = line.indexOf(close, pos + open.length)
        if (end < 0) {
          pushTo(out, 'string', line.slice(pos))
          mode = 'longString'
          quote = close
          pos = n
          break
        }
        push('string', line.slice(pos, end + close.length))
        pos = end + close.length
        continue
      }
    }
    if (lang.triple && line.startsWith('"""', pos)) {
      const end = line.indexOf('"""', pos + 3)
      if (end < 0) {
        pushTo(out, 'string', line.slice(pos))
        mode = 'triple'
        quote = '"""'
        pos = n
        break
      }
      push('string', line.slice(pos, end + 3))
      pos = end + 3
      continue
    }
    if (c === '"' || c === "'" || (c === '`' && langName === 'sh')) {
      const end = closeQuote(line, pos + 1, c)
      const stop = end < 0 ? n : end
      push('string', line.slice(pos, stop))
      pos = stop
      continue
    }
    if (c === '$' && lang.dollar) {
      const v = stick(langName === 'sh' ? SH_VAR : GVAR, line, pos)
      if (v) {
        push('variable', v)
        pos += v.length
        continue
      }
    }
    if (lang.sigils && c === ':' && line[pos + 1] !== ':' && (!prev || (prev as Token).kind === 'punct' || (prev as Token).kind === 'operator' || /[ \t(]/.test(line[pos - 1] ?? ' '))) {
      const s = stick(SYMBOL, line, pos)
      if (s) {
        push('constant', s)
        pos += s.length
        continue
      }
    }
    if (lang.sigils && c === '@') {
      const v = stick(IVAR, line, pos)
      if (v) {
        push('variable', v)
        pos += v.length
        continue
      }
    }
    const num = /[0-9.]/.test(c) ? stick(CNUMBER, line, pos) : null
    if (num && num !== '.') {
      push('number', num)
      pos += num.length
      continue
    }
    const word = stick(SCRIPT_IDENT, line, pos)
    if (word) {
      const key = lang.fold ? word.toLowerCase() : word
      let kind: TokenKind
      if (after) kind = 'function'
      else if (lang.keywords.has(key)) kind = 'keyword'
      else if (lang.constants.has(key)) kind = 'constant'
      else if (lang.types?.has(key)) kind = 'type'
      else if (nextIsCall(line, pos + word.length)) kind = 'function'
      else if (/^[A-Z]/.test(word) && !lang.fold) kind = 'type'
      else kind = 'text'
      after = ['def', 'defp', 'function', 'defmacro'].includes(key) ? key : null
      push(kind, word)
      pos += word.length
      continue
    }
    after = null
    const p = stick(PUNCT, line, pos)
    if (p) {
      push('punct', p)
      pos += p.length
      continue
    }
    const op = stick(OPERATOR, line, pos)
    if (op) {
      push('operator', op)
      pos += op.length
      continue
    }
    pushTo(out, 'text', c)
    pos++
  }
  return mode === 'code' ? { mode } : { mode, ...(quote !== undefined ? { quote } : {}) }
}

/* -------------------------------------------------------- style sheets */

const CSS_AT = /@[\w-]+/y
const CSS_SELECTOR = /[.#][\w-]+/y
const CSS_PSEUDO = /::?[\w-]+/y
const CSS_ATTR = /\[[^\]\n]{0,200}\]?/y
const CSS_WORD = /-?[A-Za-z_][\w-]*/y
const CSS_CUSTOM = /--[\w-]+/y
const CSS_HEX = /#[0-9a-fA-F]{3,8}(?![\w-])/y
const CSS_NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:%|[A-Za-z]+)?/y
const CSS_VAR = /[$@][\w-]+/y
const CSS_IMPORTANT = /![ \t]*important/y
const CSS_PROP_END = /[ \t]{0,8}:/y
const MEDIA_WORDS = set('and not only screen print all or')

function lexCss(line: string, start: LexState, langName: string, out: Token[]): LexState {
  let mode = start.mode
  let depth = start.depth ?? 0
  const n = line.length
  let pos = 0
  let parens = 0
  const lineComment = langName !== 'css'
  const trimmed = line.replace(/\/\*.*?\*\//g, '').replace(lineComment ? /\/\/.*$/ : /$^/, '').trim()
  // A selector line: anything at the top level, or a nested rule's opening (`&:hover {`, a list ending in `,`).
  let selector = depth === 0 || trimmed.endsWith('{') || (trimmed.endsWith(',') && !/:\s/.test(trimmed))
  let atProp = true
  const push = (kind: TokenKind, text: string): void => pushTo(out, kind, text)
  while (pos < n) {
    if (mode === 'comment') {
      const end = line.indexOf('*/', pos)
      if (end < 0) {
        push('comment', line.slice(pos))
        pos = n
        break
      }
      push('comment', line.slice(pos, end + 2))
      pos = end + 2
      mode = 'code'
      continue
    }
    const ws = stick(WS, line, pos)
    if (ws) {
      push('text', ws)
      pos += ws.length
      continue
    }
    const c = line[pos]
    if (c === '/' && line[pos + 1] === '*') {
      mode = 'comment'
      push('comment', '/*')
      pos += 2
      continue
    }
    if (lineComment && c === '/' && line[pos + 1] === '/' && line[pos - 1] !== ':') {
      push('comment', line.slice(pos))
      pos = n
      break
    }
    if (c === '"' || c === "'") {
      const end = closeQuote(line, pos + 1, c)
      const stop = end < 0 ? n : end
      push('string', line.slice(pos, stop))
      pos = stop
      continue
    }
    if (c === '{') {
      push('punct', c)
      pos++
      depth++
      selector = false
      atProp = true
      continue
    }
    if (c === '}') {
      push('punct', c)
      pos++
      depth = Math.max(0, depth - 1)
      selector = depth === 0
      atProp = true
      continue
    }
    if (c === ';') {
      push('punct', c)
      pos++
      atProp = true
      continue
    }
    if (c === '@') {
      const at = stick(CSS_AT, line, pos)
      if (at) {
        push(selector || atProp ? 'keyword' : 'variable', at)
        pos += at.length
        continue
      }
    }
    const inValue = !selector || parens > 0
    if (!inValue) {
      if (c === '.' || c === '#') {
        const s = stick(CSS_SELECTOR, line, pos)
        if (s) {
          push('type', s)
          pos += s.length
          continue
        }
      }
      if (c === ':') {
        const s = stick(CSS_PSEUDO, line, pos)
        if (s) {
          push('keyword', s)
          pos += s.length
          continue
        }
      }
      if (c === '[') {
        const a = stick(CSS_ATTR, line, pos)
        if (a) {
          push('attr', a)
          pos += a.length
          continue
        }
      }
      if (c === '(') {
        push('punct', c)
        pos++
        parens++
        atProp = true
        continue
      }
      const num = /[0-9.-]/.test(c) ? stick(CSS_NUMBER, line, pos) : null
      if (num && /\d/.test(num)) {
        push('number', num)
        pos += num.length
        continue
      }
      const w = stick(CSS_WORD, line, pos)
      if (w) {
        push(MEDIA_WORDS.has(w) ? 'keyword' : 'tag', w)
        pos += w.length
        continue
      }
      push(c === ',' ? 'punct' : /[>+~*&]/.test(c) ? 'operator' : 'text', c)
      pos++
      continue
    }
    // In a declaration, or inside a selector's parentheses (a media query's `(max-width: 40rem)`).
    if (c === ')') {
      push('punct', c)
      pos++
      parens = Math.max(0, parens - 1)
      continue
    }
    if (c === '(') {
      push('punct', c)
      pos++
      if (selector) parens++
      continue
    }
    if (c === '-' && line[pos + 1] === '-') {
      const v = stick(CSS_CUSTOM, line, pos)
      if (v) {
        CSS_PROP_END.lastIndex = pos + v.length
        push(atProp && CSS_PROP_END.test(line) ? 'property' : 'variable', v)
        pos += v.length
        atProp = false
        continue
      }
    }
    if (c === '#') {
      const h = stick(CSS_HEX, line, pos)
      if (h) {
        push('number', h)
        pos += h.length
        continue
      }
    }
    if (c === '!') {
      const imp = stick(CSS_IMPORTANT, line, pos)
      if (imp) {
        push('keyword', imp)
        pos += imp.length
        continue
      }
    }
    if (c === '$' || (c === '@' && langName === 'less')) {
      const v = stick(CSS_VAR, line, pos)
      if (v) {
        push('variable', v)
        pos += v.length
        continue
      }
    }
    const num = /[0-9.-]/.test(c) ? stick(CSS_NUMBER, line, pos) : null
    if (num && /\d/.test(num)) {
      push('number', num)
      pos += num.length
      atProp = false
      continue
    }
    const w = stick(CSS_WORD, line, pos)
    if (w) {
      const end = pos + w.length
      CSS_PROP_END.lastIndex = end
      if (atProp && CSS_PROP_END.test(line)) push('property', w)
      else if (line[end] === '(') {
        push('function', w)
        if (w === 'url') {
          const inner = /^\(([^)\n]{0,400})/.exec(line.slice(end))
          if (inner) {
            push('punct', '(')
            push('string', inner[1])
            pos = end + 1 + inner[1].length
            atProp = false
            continue
          }
        }
      } else push(MEDIA_WORDS.has(w) && selector ? 'keyword' : 'constant', w)
      pos = end
      atProp = false
      continue
    }
    if (c === ':' || c === ',') {
      push('punct', c)
      pos++
      continue
    }
    push(/[+*/=<>~^|]/.test(c) ? 'operator' : 'text', c)
    pos++
  }
  return mode === 'comment' ? { mode, depth } : { mode: 'code', depth }
}

/* ----------------------------------------------------------------- HTML */

const HTML_TAG = /[A-Za-z][\w:.-]*/y
const HTML_ATTR = /[^\s"'<>/=]+/y
const HTML_ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y
const HTML_TEXT = /[^<&]+/y

function lexHtml(line: string, start: LexState, out: Token[]): LexState {
  let mode = start.mode
  let tag = start.tag
  let quote = start.quote
  let embed = start.embed
  const n = line.length
  let pos = 0
  const lower = line.toLowerCase()
  const push = (kind: TokenKind, text: string): void => pushTo(out, kind, text)
  while (pos < n) {
    if (mode === 'embed' && embed) {
      const close = lower.indexOf('</' + (embed.grammar === 'css' ? 'style' : 'script'), pos)
      const stop = close < 0 ? n : close
      if (stop > pos) {
        const r = tokenizeLine(embed.grammar, line.slice(pos, stop), embed.state, embed.grammar === 'css' ? 'css' : undefined)
        for (const t of r.tokens) push(t.kind, t.text)
        embed = { grammar: embed.grammar, state: r.end }
      }
      pos = stop
      if (close >= 0) {
        mode = 'text'
        embed = undefined
      }
      continue
    }
    if (mode === 'comment') {
      const end = line.indexOf('-->', pos)
      if (end < 0) {
        push('comment', line.slice(pos))
        pos = n
        break
      }
      push('comment', line.slice(pos, end + 3))
      pos = end + 3
      mode = 'text'
      continue
    }
    if (mode === 'attr') {
      const q = quote ?? '"'
      const end = line.indexOf(q, pos)
      if (end < 0) {
        push('string', line.slice(pos))
        pos = n
        break
      }
      push('string', line.slice(pos, end + 1))
      pos = end + 1
      mode = 'tag'
      quote = undefined
      continue
    }
    if (mode === 'tag') {
      const ws = stick(WS, line, pos)
      if (ws) {
        push('text', ws)
        pos += ws.length
        continue
      }
      if (line.startsWith('/>', pos)) {
        push('punct', '/>')
        pos += 2
        mode = 'text'
        tag = undefined
        continue
      }
      const c = line[pos]
      if (c === '>') {
        push('punct', '>')
        pos++
        mode = 'text'
        if (tag === 'script' || tag === 'style') {
          mode = 'embed'
          const grammar: Grammar = tag === 'style' ? 'css' : 'js'
          embed = { grammar, state: plainState(grammar) }
        }
        tag = undefined
        continue
      }
      if (c === '"' || c === "'") {
        const end = line.indexOf(c, pos + 1)
        if (end < 0) {
          push('string', line.slice(pos))
          mode = 'attr'
          quote = c
          pos = n
          break
        }
        push('string', line.slice(pos, end + 1))
        pos = end + 1
        continue
      }
      if (c === '=') {
        push('punct', c)
        pos++
        continue
      }
      const a = stick(HTML_ATTR, line, pos)
      if (a) {
        push('attr', a)
        pos += a.length
        continue
      }
      push('text', c)
      pos++
      continue
    }
    // text
    const c = line[pos]
    if (c === '<') {
      if (line.startsWith('<!--', pos)) {
        mode = 'comment'
        push('comment', '<!--')
        pos += 4
        continue
      }
      if (line[pos + 1] === '!') {
        const name = stick(HTML_TAG, line, pos + 2)
        if (name) {
          push('punct', '<!')
          push('keyword', name)
          pos += 2 + name.length
          mode = 'tag'
          tag = '!'
          continue
        }
      }
      const closing = line[pos + 1] === '/'
      const name = stick(HTML_TAG, line, pos + (closing ? 2 : 1))
      if (name) {
        push('punct', closing ? '</' : '<')
        push('tag', name)
        pos += (closing ? 2 : 1) + name.length
        mode = 'tag'
        tag = closing ? '/' + name.toLowerCase() : name.toLowerCase()
        continue
      }
      push('text', c)
      pos++
      continue
    }
    if (c === '&') {
      const e = stick(HTML_ENTITY, line, pos)
      if (e) {
        push('constant', e)
        pos += e.length
        continue
      }
      push('text', c)
      pos++
      continue
    }
    const t = stick(HTML_TEXT, line, pos)
    if (t) {
      push('text', t)
      pos += t.length
      continue
    }
    push('text', c)
    pos++
  }
  const end: LexState = { mode }
  if (mode === 'tag' && tag !== undefined) end.tag = tag
  if (mode === 'attr') {
    end.quote = quote ?? '"'
    if (tag !== undefined) end.tag = tag
  }
  if (mode === 'embed' && embed) end.embed = embed
  return end
}

/* ------------------------------------------------------------- markdown */

/** A fence's info word to the grammar inside it, so a README's code block is coloured as code. */
const FENCE_LANGS: Readonly<Record<string, { grammar: Grammar; lang?: string }>> = {
  js: { grammar: 'js' }, javascript: { grammar: 'js' }, mjs: { grammar: 'js' }, cjs: { grammar: 'js' }, ts: { grammar: 'js' },
  typescript: { grammar: 'js' }, json: { grammar: 'js' }, jsonc: { grammar: 'js' }, jsx: { grammar: 'jsx' }, tsx: { grammar: 'jsx' },
  sh: { grammar: 'script', lang: 'sh' }, bash: { grammar: 'script', lang: 'sh' }, zsh: { grammar: 'script', lang: 'sh' },
  shell: { grammar: 'script', lang: 'sh' }, console: { grammar: 'script', lang: 'sh' }, ruby: { grammar: 'script', lang: 'ruby' },
  rb: { grammar: 'script', lang: 'ruby' }, lua: { grammar: 'script', lang: 'lua' }, sql: { grammar: 'script', lang: 'sql' },
  elixir: { grammar: 'script', lang: 'elixir' }, py: { grammar: 'python' }, python: { grammar: 'python' },
  css: { grammar: 'css', lang: 'css' }, scss: { grammar: 'css', lang: 'scss' }, less: { grammar: 'css', lang: 'less' },
  html: { grammar: 'html' }, xml: { grammar: 'html' }, vue: { grammar: 'html' }, svelte: { grammar: 'html' },
  rust: { grammar: 'clike', lang: 'rust' }, rs: { grammar: 'clike', lang: 'rust' }, go: { grammar: 'clike', lang: 'go' },
  c: { grammar: 'clike', lang: 'c' }, cpp: { grammar: 'clike', lang: 'cpp' }, java: { grammar: 'clike', lang: 'java' },
  kotlin: { grammar: 'clike', lang: 'kotlin' }, swift: { grammar: 'clike', lang: 'swift' }, cs: { grammar: 'clike', lang: 'cs' },
  csharp: { grammar: 'clike', lang: 'cs' }, dart: { grammar: 'clike', lang: 'dart' }, php: { grammar: 'clike', lang: 'php' }
}

const MD_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const MD_HEADING = /^( {0,3})(#{1,6}(?:[ \t].*)?)$/
const MD_QUOTE = /^ {0,3}>/
const MD_RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const MD_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t]|$)/
/** `[text](url)` or `![alt](src)`, bounded so a line of brackets stays linear. */
const MD_LINK = /!?\[[^\]\n]{0,200}\]\([^)\s]{0,500}\)/y
const MD_AUTOLINK = /<https?:\/\/[^<>\s]{1,500}>/y
const MD_TAG = /<\/?[A-Za-z][\w-]{0,40}[^<>\n]{0,300}>/y
const MD_TEXT = /[^`[!<|\\]+/y

/** A line's inline Markdown from `pos`: code spans, links, inline tags, table pipes, the rest as text. */
function lexMarkdownInline(line: string, pos: number, push: (kind: TokenKind, text: string) => void): void {
  const n = line.length
  // A backtick run of a length that found no closer once never finds one later on the line (linear, not quadratic).
  const unclosed = new Set<number>()
  while (pos < n) {
    const c = line[pos]
    if (c === '`') {
      let run = 1
      while (line[pos + run] === '`') run++
      let close = -1
      if (!unclosed.has(run)) {
        for (let at = line.indexOf('`', pos + run); at >= 0; ) {
          let k = 1
          while (line[at + k] === '`') k++
          if (k === run) {
            close = at
            break
          }
          at = line.indexOf('`', at + k)
        }
        if (close < 0) unclosed.add(run)
      }
      if (close < 0) {
        push('text', line.slice(pos, pos + run))
        pos += run
      } else {
        push('string', line.slice(pos, close + run))
        pos = close + run
      }
      continue
    }
    if (c === '[' || (c === '!' && line[pos + 1] === '[')) {
      const link = stick(MD_LINK, line, pos)
      if (link) {
        const mid = link.indexOf('](')
        push('type', link.slice(0, mid + 1))
        push('string', link.slice(mid + 1))
        pos += link.length
        continue
      }
      push('text', c)
      pos++
      continue
    }
    if (c === '<') {
      const auto = stick(MD_AUTOLINK, line, pos)
      const tag = auto ? null : stick(MD_TAG, line, pos)
      if (auto || tag) {
        push(auto ? 'string' : 'tag', (auto ?? tag) as string)
        pos += (auto ?? tag as string).length
        continue
      }
      push('text', c)
      pos++
      continue
    }
    if (c === '|') {
      push('punct', c)
      pos++
      continue
    }
    if (c === '\\') {
      // An escape takes the next character with it.
      push('text', line.slice(pos, pos + 2))
      pos += 2
      continue
    }
    const t = stick(MD_TEXT, line, pos)
    if (t) {
      push('text', t)
      pos += t.length
      continue
    }
    push('text', c)
    pos++
  }
}

/**
 * Markdown, a line at a time: headings and list markers (blue, as VS Code
 * draws them), quotes as comments, rules and table pipes as punctuation, code
 * spans as strings, links, and fenced code coloured by its info word's grammar
 * (`FENCE_LANGS`) until the matching fence closes it. A fence is not the plain
 * state, so no hole is ever left inside a code block.
 */
function lexMarkdown(line: string, start: LexState, out: Token[]): LexState {
  const push = (kind: TokenKind, text: string): void => pushTo(out, kind, text)
  if (start.mode === 'fence') {
    const fence = start.quote ?? '```'
    const lead = /^ {0,3}/.exec(line)?.[0] ?? ''
    let run = 0
    while (line[lead.length + run] === fence[0]) run++
    if (run >= fence.length && line.slice(lead.length + run).trim() === '') {
      push('text', lead)
      push('punct', line.slice(lead.length, lead.length + run))
      push('text', line.slice(lead.length + run))
      return plainState('markdown')
    }
    if (start.embed) {
      const r = tokenizeLine(start.embed.grammar, line, start.embed.state, start.embed.lang)
      for (const t of r.tokens) push(t.kind, t.text)
      const embed: LexState['embed'] = { grammar: start.embed.grammar, state: r.end }
      if (start.embed.lang !== undefined) embed.lang = start.embed.lang
      return { mode: 'fence', quote: fence, embed }
    }
    push('text', line)
    return { mode: 'fence', quote: fence }
  }
  const open = MD_FENCE.exec(line)
  if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
    push('text', open[1])
    push('punct', open[2])
    push('type', open[3])
    const word = open[3].trim().split(/[\s{,]/)[0].toLowerCase()
    const end: LexState = { mode: 'fence', quote: open[2] }
    if (Object.hasOwn(FENCE_LANGS, word)) {
      const known = FENCE_LANGS[word]
      end.embed = { grammar: known.grammar, state: plainState(known.grammar) }
      if (known.lang !== undefined) end.embed.lang = known.lang
    }
    return end
  }
  const heading = MD_HEADING.exec(line)
  if (heading) {
    push('text', heading[1])
    push('function', heading[2])
    return start
  }
  if (MD_RULE.test(line)) {
    push('punct', line)
    return start
  }
  if (MD_QUOTE.test(line)) {
    push('comment', line)
    return start
  }
  let pos = 0
  const list = MD_LIST.exec(line)
  if (list) {
    push('text', list[1])
    push('function', list[2])
    pos = list[0].length
  }
  lexMarkdownInline(line, pos, push)
  return start
}

/* ---------------------------------------------------------------- entry */

/** One line's tokens and the state the next line starts in. */
export function tokenizeLine(grammar: Grammar, line: string, state: LexState, lang?: string): { tokens: Token[]; end: LexState } {
  const tokens: Token[] = []
  let end: LexState
  switch (grammar) {
    case 'js':
      end = lexJs(line, state, false, tokens)
      break
    case 'jsx':
      end = lexJs(line, state, true, tokens)
      break
    case 'clike':
      end = lexClike(line, state, lang ?? 'c', tokens)
      break
    case 'python':
      end = lexPython(line, state, tokens)
      break
    case 'script':
      end = lexScript(line, state, lang ?? 'sh', tokens)
      break
    case 'css':
      end = lexCss(line, state, lang ?? 'css', tokens)
      break
    case 'markdown':
      end = lexMarkdown(line, state, tokens)
      break
    default:
      end = lexHtml(line, state, tokens)
  }
  return { tokens, end }
}

/** The state each line STARTS in, for a whole file. */
export function lineStates(grammar: Grammar, lines: readonly string[], lang?: string): LexState[] {
  const out: LexState[] = []
  let state = plainState(grammar)
  for (const line of lines) {
    out.push(state)
    state = tokenizeLine(grammar, line, state, lang).end
  }
  return out
}
