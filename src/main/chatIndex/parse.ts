/**
 * What each chat source's records say, as plain text: user and assistant words
 * only. Pure functions over one record, one JSON document or one row — no file
 * is opened here, so `verify:chat-sources` holds every rule against synthetic
 * fixtures, and `sources.ts` is only the part that reads.
 *
 * The rule for all of them is the one `readTranscript` already applies to
 * Claude Code: index what a person reads. Tool calls and their output,
 * reasoning, images and base64, system and developer turns, and context the
 * tool injected on the user's behalf are all left out. Measured on the machine
 * this was written on, that is about 1% of the bytes (Claude 4.04 MiB of 312
 * MiB, Codex 3.64 of 661) and it is the part people remember.
 *
 * Claude's text rules are `sessionFile.ts`'s own (`textOf`, `isUsefulPrompt`,
 * `titleOf`), imported rather than copied, so a search hit and the session
 * row it lands on follow one rule.
 */
import { isUsefulPrompt, safeParse, textOf, titleOf } from '../sessionFile.ts'
import { dropInvisible, HIT_CLOSE, HIT_OPEN, type ChatSourceId } from '../../shared/chatIndex.ts'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  atMs: number | null
}

export interface ChatMeta {
  title: string | null
  firstPrompt: string | null
  cwd: string | null
  gitBranch: string | null
  model: string | null
  createdMs: number | null
  updatedMs: number | null
}

export function emptyMeta(): ChatMeta {
  return { title: null, firstPrompt: null, cwd: null, gitBranch: null, model: null, createdMs: null, updatedMs: null }
}

/** What folding a run of records produced: messages in order, and what they said about the chat. */
export interface Fold {
  messages: ChatMessage[]
  meta: ChatMeta
  /** A record said this chat is a subagent's, not the user's own thread. */
  subagent: boolean
}

export function emptyFold(): Fold {
  return { messages: [], meta: emptyMeta(), subagent: false }
}

/* -------------------------------------------------------------- the text */

/** One message's text past this is cut: a pasted log is not what anyone searches for twice. */
export const MESSAGE_MAX_BYTES = 64 * 1024

/*
 * A run of 200+ characters with no space from the base64 alphabet: an image, a
 * PDF, a key file. Only the run goes, so the sentence around a pasted blob
 * stays searchable. A `data:…;base64,` URL goes whole whatever its length.
 */
const BASE64_RUN = /[A-Za-z0-9+/=_-]{200,}/g
const DATA_URL = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g

/*
 * What looks like a credential. Replaced before the text is stored, when
 * `redact` is on (the default): the index is one plaintext file holding every
 * tool's chats, and a key pasted into a chat months ago should not be one
 * search away from anyone who can read it. And whatever the setting says,
 * before any of it leaves this computer (spec 2026-10-03 §1: another computer
 * searching this one gets only cleaned text, `redact: 'force'`).
 *
 * Each rule is named, so `verify:chat-sources` holds one case per rule and a
 * measurement can count per rule. Order matters in one place: the keyed rules
 * (`password`, `api-key`, `client-secret`, `token`) run last, so a key a shaped
 * rule already took reads `api_key=[redacted]` and is left alone; the same
 * holds for the `Authorization` header after the JWT rule.
 */
export interface SecretRule {
  name: string
  re: RegExp
  /** What a match becomes: `[redacted]`, or a function that keeps the part that is not secret (a URL's host, a key's name). */
  to: string | ((match: string, ...groups: string[]) => string)
}

export const REDACTED = '[redacted]'

/**
 * Which rules a stored row was cleaned with. Bumped whenever a rule is added
 * or widened: a row cleaned under an older set is cleaned again (`recleanStale`)
 * before anything is served from it as cleaned. 1 was the first eight rules;
 * 2 added credential URLs, keyed passwords and API keys, JWTs, Stripe, Notion,
 * ClickUp, Cloudflare, and a private key cut before its END line. 3 takes an
 * unquoted keyed value whole up to the next space (2 cut it at a `&`, `;` or
 * `,` and judged only the head, so `DB_PASSWORD=Xy7&kL9#mQ2vP` stayed whole
 * and `api_key=9f8e7d6c,5b4a…` kept its tail), judges a dotted value by its
 * segments (2 left any value that began `word.word`: `SENDGRID_API_KEY=SG.…`),
 * and adds SendGrid, Mapbox, `Authorization:` headers, AWS secret access keys,
 * GitLab, Hugging Face, npm, Stripe webhook secrets, and keyed client secrets
 * and tokens. 4 (re-review of 62b4ae6) reads a keyed value in escaped JSON
 * (`{\"password\":\"…\"}`), takes keyed secrets (`secret`, `NEXTAUTH_SECRET`,
 * `SECRET_KEY`, `PRIVATE_KEY`), a dotted value after `name=` with no space
 * unless its last segment names the credential (`db_password=correct.horse.battery9`
 * was code to 3), command-line flags (`--password X`, `mysql -pX`,
 * `curl -u user:pass`), Slack webhooks, Azure account keys, Telegram bot
 * tokens and an upper-case `AUTHORIZATION:`; and leaves a value with a
 * template in it, a `YOUR…` placeholder, a credential's own name and a typed
 * array's. 5 (review of 166e84f) drops invisible characters inside a word
 * before judging (`dropInvisible`), takes a key split after its prefix by a
 * line break or a space (`split-key`), a Telegram token in its Bot API URL, a
 * PGP private key block, Groq, Google OAuth client secrets and access tokens,
 * Vault tokens, Slack app and rotation tokens, Discord webhooks, Azure SAS
 * signatures, Laravel's `APP_KEY`, `Authorization: Bot`, a cookie header's
 * session values, `.pgpass` lines and PHP's `print_r` of a credential; the
 * password flags of `sshpass`, `redis-cli`, `docker login`, `openssl`,
 * `mongo` and `mysql --password=`, `vault login`, `--passphrase`; keyed
 * `pass`/`DB_PASS`/`passphrase`, and secret names with a suffix
 * (`SECRET_KEY_BASE`, `secret_access_key`). A re-clean also makes the cut tail
 * of a title the cap's length `[redacted]` (`recleanChat`). 6 (review of
 * 10b0840) drops every default-ignorable code point inside a word
 * (`dropInvisible`), a first prompt's too before it is cut (`\s` read a byte
 * order mark as a space), takes a key split after its prefix by any Unicode
 * space, an indented line break or a quoted reply's `> ` (`SPLIT_SEP`), a
 * Telegram token after `bot` with no slash or with its colon as `%3A`, and
 * the word Cline's own title cut (`toolCutTitle`; a re-clean, every Cline
 * title ending in `…`).
 */
export const REDACTION_VERSION = 6

/*
 * A keyed value — `password=…`, `"apiKey": "…"`, `DB_PASSWORD: …` — is only a
 * secret when it is a literal. Code says these names all day with a type, a
 * variable or a lookup on the right (`password: string`, `password=password`,
 * `apiKey: process.env.KEY`, `password: z.string()`), and a shell's `PWD` is a
 * folder; none of those is redacted. A quoted value is a literal unless it is
 * a placeholder or starts or ends with a space (`"Password: " + pw + "!"` — the
 * quotes are two strings' ends, not one value's). An unquoted one must also
 * not be a bare word, a constant's name, a property path, a call, a path or an
 * escape (`\n1449`: a line of grep output, JSON-escaped), judged without the
 * punctuation that closes it (`password: string):`). Except in a shell or
 * `.env` assignment (`POSTGRES_PASSWORD=postgres`: a name with no lower case,
 * then `=` and nothing between) or a URL query (`?token=…`): there a bare word
 * or a dotted one IS the value, unless it is a type. A colon never gets that
 * reading — `{ PWD: cwd }` is code.
 *
 * A property path is code only while every segment has an identifier's shape
 * (`secretSegment`): `SG.Ab3Cd….Ef7Gh…` and `p4ss.Word.xyz` are values that
 * merely contain dots. A call, an index or an operator straight after a name
 * is code whatever the name (`base64.b64decode(x)`, `process.env.X||'d'`).
 *
 * An unquoted value runs to the next space, or to a quote that ends the
 * string it sits in: a `&`, `;` or `,` inside it is part of it
 * (`Xy7&kL9#mQ2vP`). Only a key that itself follows `?`, `&` or `;` — a URL
 * query, a connection string — has a value that ends at the next `&` or `;`
 * (`;` alone after a `;`, as `Password=a&b;` is one value). Trailing structure
 * (`,` `;` `&` `)` `]` `}` `>`) is put back after `[redacted]`.
 *
 * The colon must follow the name directly (`password: x`, `"password": "x"`),
 * so a ternary's `'new-password' : 'current-password'` is not a pair; `=`,
 * `=>` and `:=` may have spaces round them. `${PASSWORD:-…}` is a shell
 * expansion, not an assignment.
 *
 * Measured on a copy of a real index (8,478 messages, 2026-10-03) and on this
 * repository's own source before this was settled: a backtick-quoted value
 * was dropped because markdown's inline code made it take the prose between
 * two code spans (5 of the first 14 taken).
 */
const TYPE_WORDS = new Set(['str', 'string', 'String', 'int', 'bool', 'boolean', 'None', 'null', 'nil', 'undefined', 'true', 'false', 'True', 'False', 'any', 'unknown', 'required', 'optional', 'Optional', 'Secret', 'SecretStr', 'bytes', 'text'])

/** What closes a value rather than belonging to it: a value is judged without it. */
const CLOSING = ')]}>:.,!?;&'
/** The part of `CLOSING` that is structure, put back after `[redacted]`: `{ password: x, … }`, `PASSWORD=x;`, `(password=x)`. */
const STRUCTURE = ',;&)]}>'

/**
 * `s` without its trailing run of `chars`, walked from the end. Never a
 * `/[…]+$/` regex: it retries from every position of a run that does not
 * reach the end, so `password=a` + 64 KB of `)` + `x` took 6.8 s (measured;
 * 2 had it, with one such regex).
 */
function trimTail(s: string, chars: string): string {
  let end = s.length
  while (end > 0 && chars.includes(s[end - 1])) end--
  return s.slice(0, end)
}

/** A name or a dotted path of them at the start of a value: `getpass`, `process.env.KEY`, `self.api_key`, `Foo::BAR`, `$this->pw`. */
const PATH_HEAD = /^[A-Za-z_$][\w$]*(?:(?:\.|::|->|\?\.)[A-Za-z_$][\w$]*)*/
const PATH_SEP = /\.|::|->|\?\./

/*
 * A segment no identifier has the shape of: 12+ characters that MIX letters
 * and digits — at least one switch between lower case, upper case and digits
 * for every three characters, which a random string has (`dEf456gHi789jKl`:
 * 10 in 15) and a name with a number in it does not (`oauth2ClientSecret`: 5
 * in 18, `OPENROUTER_KEY_2`: 1) — or digits between two lower-case letters
 * (`p4ss`, `s3cr3t`; `s3Key` is a name). Measured on the keyed values that are
 * dotted paths in a real index's copy, this repository and node_modules'
 * markdown (47, all code): neither clause took one.
 */
function secretSegment(s: string): boolean {
  if (s.length >= 12) {
    let switches = 0
    let prev = ''
    for (const c of s) {
      const k = c >= '0' && c <= '9' ? 'd' : c >= 'a' && c <= 'z' ? 'l' : c >= 'A' && c <= 'Z' ? 'u' : ''
      if (k && prev && k !== prev) switches++
      if (k) prev = k
    }
    if (/[0-9]/.test(s) && /[A-Za-z]/.test(s) && switches * 3 >= s.length) return true
  }
  return /[a-z][0-9]+[a-z]/.test(s)
}

/** A credential's own name as its value: a how-to's placeholder. */
const PLACEHOLDER_WORDS = new Set(['password', 'passwd', 'passphrase', 'pass', 'pwd', 'secret', 'token', 'apikey', 'api_key'])
/** A snake-case name that ends in a credential's (`client_key_passphrase`, `db_password`): a how-to's placeholder too. */
const PLACEHOLDER_NAME = /^(?:[a-z]+_)+(?:password|passwd|passphrase|pass|pwd|secret|token|api_?key)$/

/** A typed array's name: what `secret: Uint8Array` declares, never a value. */
const TYPED_ARRAY = /^(?:Big)?(?:Uint|Int|Float)(?:8|16|32|64)(?:Clamped)?Array$/

/** A path segment that names what the key holds (`self.password`, `args.api_key`, `cfg.db_pw`) or a constant (`settings.API_KEY`). */
const NAMES_CREDENTIAL = /pass|pwd|pw|secret|key|token|auth|cred/i
const CONSTANT = /^[A-Z][A-Z0-9_]*$/

/**
 * Is a dotted value a property path in code? Not when any segment has a
 * secret's shape (`secretSegment`). In `name=value` written with no space —
 * a `.env`, a properties file, a shell, `db_password=correct.horse.battery9`
 * — it is code only when its last segment names the credential or a constant
 * (`password=self.password`, `api_key=settings.API_KEY`); anywhere else
 * (`password: req.body.pw`, `token = this.x.y`) any such path is code.
 */
function codePath(head: string, assign: boolean): boolean {
  const segs = head.split(PATH_SEP)
  if (segs.some(secretSegment)) return false
  if (!assign) return true
  const last = segs[segs.length - 1]
  return NAMES_CREDENTIAL.test(last) || CONSTANT.test(last)
}

/**
 * `literal`: a bare word IS the value (a shell or `.env` assignment in capitals, a URL query, `mysql -p…`).
 * `assign`: written `name=value` with no space round the `=` (`codePath`).
 * `plainIsCode`: a value of words only or digits only is prose or a count, quoted or not, unless `literal`
 * (`pass: 'PASS'` and `{ pass: 120, fail: 3 }` are a test's; `DB_PASS=hunter` is a password).
 */
function literalSecret(value: string, quoted: boolean, min: number, literal: boolean, assign = false, plainIsCode = false): boolean {
  /*
   * Already taken, or a blob: the marker alone is left. Anything glued on
   * after it is the rest of a value an older rule set cut short (2 stopped at
   * `&`, `;` and `,`: `api_key=[redacted],5b4a…`), and goes too.
   */
  const marker = /^\[(?:redacted|data)\]/.exec(value)
  // A backslash alone after it is markdown's line break (`key=[redacted]\`), and another marker is no key either.
  if (marker) return !quoted && trimTail(value.slice(marker[0].length).replace(/\\?\[(?:redacted|data)\]/g, ''), CLOSING + '\\') !== ''
  if (value.length < min) return false
  // Masked, or a template / variable standing in for the value.
  if (/^(?:\*+|•+|x+|X+|\.{3,}|…+)$/.test(value)) return false
  if (/^(?:\$+\{|\{\{|\$\(|<[^<>]*>$|&lt;.*&gt;$|%[\w.]+%$|\$[A-Za-z_][\w-]*$)/.test(value)) return false
  // A template anywhere in it: code building a string (`stoke-secret:v1:${path}`), never a value.
  if (value.includes('${') || value.includes('{{')) return false
  if (/^your[-_ ]/i.test(value) || /^(?:YOUR|[Yy]our)[A-Z]/.test(value)) return false
  // The name standing in for itself (`curl -u user:pass`, `-p password` in a how-to).
  if (PLACEHOLDER_WORDS.has(value) || PLACEHOLDER_NAME.test(value)) return false
  if (plainIsCode && !literal && /^(?:[A-Za-z]+(?: [A-Za-z]+)*|[0-9]+)$/.test(quoted ? value : trimTail(value, CLOSING))) return false
  if (quoted) return !/^\s|\s$/.test(value)
  if (value.startsWith('\\')) return false
  const v = trimTail(value, CLOSING)
  if (v.length < min) return false
  // A word with no digit or symbol: a type, a keyword, a variable (`string`, `None`, `required`).
  if (/^[A-Za-z_-]+$/.test(v)) return literal && !TYPE_WORDS.has(v)
  // A constant's name: `OPENROUTER_KEY_2`; a typed array's: `Uint8Array`; a number in hex (`STENCIL_PASS_DEPTH_PASS: 0x0B96`; a key's 0x… is longer).
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) || TYPED_ARRAY.test(v) || /^0x[0-9A-Fa-f]{1,8}$/.test(v)) return false
  const head = PATH_HEAD.exec(v)?.[0] ?? ''
  const rest = v.slice(head.length)
  // A call, an index, a type's parameters or an operator after a name or a path: `getpass()`, `z.string().min(8)`, `os.environ['X']`, `Option<String>`, `env.X||'d'`.
  if (head && /^(?:[([{<]|\|\||\?\?|&&)/.test(rest)) return false
  // A property path whose every segment is a name's: `process.env.X`, `req.body.password`.
  if (!literal && rest === '' && PATH_SEP.test(head) && codePath(head, assign)) return false
  // A path: a shell's `PWD=/Users/…`, a file the value is read from.
  if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(v)) return false
  // Structure, a placeholder's or markup's opening (`<string>}` judged without its `>}`), or a regex's alternation (`/(pass:|-pass )/`).
  if (/^[{[(<|]/.test(v)) return false
  return true
}

/**
 * Before a value: the key's whole glued name and its `=`, for the lookbehinds
 * that tell a URL query from the rest. Bounded everywhere: when a value does
 * not match, the engine backs off one space of the separator at a time and
 * runs these again, so an unbounded `[ \t]*` here made `password=` + 64 KB of
 * spaces + `"` take 19 s (measured).
 */
const QUERY_KEY = String.raw`[\w.-]{0,64}[ \t]{0,4}=[ \t]{0,4}`
const BT = '`'
/** One character of an unquoted value: not a space or a quote, and not an escaped `\n`, `\r` or `\t` — a line's end in JSON-escaped text. */
const CH = String.raw`(?:[^\s"'${BT}\\]|\\(?![nrt]))`
const VALUE =
  // A value in escaped quotes first: JSON inside a JSON string (`{\"password\":\"…\"}`), a log line's.
  String.raw`(?:\\"([^"\\\n]*)\\"|"([^"\n]*)"|'([^'\n]*)'` +
  // A URL query's value ends at the next `&`, `;` or `#`, or a bracket that closes the link around it
  // (`badge.svg?token=x)](https://…)`); a connection string's at the next `;`.
  String.raw`|((?<=[?&]${QUERY_KEY})[^\s"'${BT}\\&;#()<>[\]{}]+|(?<=;${QUERY_KEY})(?:(?!;)${CH})+)` +
  // Anything else runs to the next space, or to a quote that closes the string around it: a quote
  // straight after structure always does (compact JSON's `null},"hasMore":false`), one inside a word
  // (`Xy7'kL9`) only when space or structure follows it.
  String.raw`|(?<![?&;]${QUERY_KEY})(${CH}+(?:(?<![,;:=([{)\]}])["'](?:(?![,;)\]}])${CH})+)*))`

/**
 * A rule for `<name> = <value>` in the ways code and config write it:
 * `name=v`, `name: v`, `"name": "v"`, `'name' => 'v'`, `name := "v"`, and
 * escaped JSON's `\"name\":\"v\"`. The name is kept, so "password" is still
 * searchable; only a literal value goes. `dottedAssign`: a dotted value after
 * `name=` with no space is judged by its last segment (`codePath`) — the
 * password rule's alone, as measured; elsewhere `api_key=config.openai` is code.
 */
function keyed(name: string, keyPattern: string, min: number, opts: { dottedAssign?: boolean; plainIsCode?: boolean } = {}): SecretRule {
  return {
    name,
    // The lookbehind is bounded: unbounded, it re-scanned a whole identifier run at every name inside it (0.8 s for 64 KB).
    re: new RegExp(String.raw`(?<!\$\{[A-Za-z0-9_.-]{0,64})(${keyPattern})((?:\\?["'])?(?::(?!=)|[ \t]*(?:=>|:=|=))[ \t]*)` + VALUE, 'g'),
    to: (match, key, sep, edq, dq, sq, query, bare) => {
      const quoted = edq ?? dq ?? sq
      const v = quoted ?? query ?? bare ?? ''
      const literal = query !== undefined || (sep === '=' && !/[a-z]/.test(key))
      if (!literalSecret(v, quoted !== undefined, min, literal, opts.dottedAssign === true && sep === '=', opts.plainIsCode === true)) return match
      const q = edq !== undefined ? '\\"' : dq !== undefined ? '"' : sq !== undefined ? "'" : ''
      const kept = quoted === undefined ? v.slice(trimTail(v, STRUCTURE).length) : ''
      return `${key}${sep}${q}${REDACTED}${q}${kept}`
    }
  }
}

/** A shaped value after a name that says what it is: the name and its separator stay. */
const keepName = (_m: string, name: string): string => `${name}${REDACTED}`

/** The value after a command-line flag: quoted, or the run to the next space. */
const ARG = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'${BT}]+))`
/** `ARG` that is never the next flag: a bare value does not start with `-`. */
const ARG_VALUE = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'${BT}-][^\s"'${BT}]*))`
/** From a command's name to a flag of its: one line, and never past `;`, `&` or `|` into the next command. */
const SAME_COMMAND = String.raw`[^\n;&|]{0,200}?`

/**
 * A flag's value as `[redacted]`, its quotes and the structure after it kept, when `literalSecret` says it is one.
 * `inner` is what stays inside the quotes before it (`"pass:[redacted]"`).
 */
function flagValue(prefix: string, dq: string | undefined, sq: string | undefined, bare: string | undefined, min: number, literal: boolean, match: string, inner = ''): string {
  const quoted = dq ?? sq
  const v = quoted ?? bare ?? ''
  if (!literalSecret(v, quoted !== undefined, min, literal)) return match
  const q = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
  const kept = quoted === undefined ? v.slice(trimTail(v, STRUCTURE).length) : ''
  return `${prefix}${q}${inner}${REDACTED}${q}${kept}`
}

/** A port map (`27017:27017`, `8080:80/tcp`): what `-p` means to docker, after a container named for its database. */
const PORT_MAP = /^\d{1,5}(?::\d{1,5})+(?:\/[a-z]+)?$/

/*
 * A secret on a command line, in the shapes that cannot be mistaken for
 * anything else. The `--name=value` form is the keyed rules' already.
 * - `--password X`, `--token X`, `--api-key X`, `--passphrase X`, and those
 *   with words before them (`--db-password`, `--github-token`): judged as a
 *   keyed value is, so `--token $GITHUB_TOKEN`, `--password <pw>` and a bare
 *   word stay.
 * - `mysql -pX` (and `mysqldump`, `mysqladmin`, `mariadb`): whatever is glued
 *   to `-p` IS the password (`-p` alone, then a space, asks for it), a bare
 *   word included, as in a `.env`.
 * - `curl -u user:pass` (`--user`): the user stays, the password goes, a
 *   bare word included.
 * - `sshpass -p X` (among its own options, before the command it runs, whose
 *   `ssh -p 2222` is a port), `redis-cli -a X`, `docker login -p X`; the mongo
 *   tools' `-p X` (never a port map: `docker run --name mongo -p 27017:27017`);
 *   `mysql`'s and the mongo tools' `--password=X`: a bare word included.
 * - `openssl … -passin pass:X` (`-passout`, `enc -pass`): `pass:` says the
 *   password follows (`env:` and `file:` say where it is).
 * - `vault login s.X`: a legacy Vault token (the `hvs.` shape is the vault
 *   rule's anywhere).
 * Each looks for its command at most 200 characters back on the same line.
 */
const COMMAND_LINE_RULES: readonly SecretRule[] = [
  {
    name: 'cli-flag',
    re: new RegExp(
      String.raw`(?<![\w-])(--(?:[A-Za-z0-9]+-){0,4}(?:password|passwd|passphrase|pass|pwd|token|secret|(?:api|secret|access|private|auth)-key|apikey))(?![\w-])([ \t]{1,4})` + ARG,
      'g'
    ),
    to: (m, flag, sp, dq, sq, bare) => flagValue(`${flag}${sp}`, dq, sq, bare, /pass|pwd/.test(flag) ? 4 : /token/.test(flag) ? 12 : 8, false, m)
  },
  {
    name: 'mysql',
    re: new RegExp(String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,200}?[ \t]-p)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'${BT}-][^\s"'${BT}]*))`, 'g'),
    to: (m, pre, dq, sq, bare) => flagValue(pre, dq, sq, bare, 1, true, m)
  },
  {
    name: 'curl-user',
    re: new RegExp(String.raw`(\bcurl\b[^\n]{0,200}?[ \t](?:-u[ \t]{0,4}|--user(?:[ \t]{1,4}|=))["']?[^\s:"'@]*:)([^\s"'${BT}]+)`, 'g'),
    to: (m, pre, bare) => flagValue(pre, undefined, undefined, bare, 1, true, m)
  },
  {
    name: 'password-flag',
    re: new RegExp(
      String.raw`(\bsshpass(?:[ \t]{1,4}-[A-Za-oq-z]\S{0,64}){0,3}[ \t]{1,4}-p[ \t]{0,4}|\bredis-cli\b${SAME_COMMAND}[ \t]-a[ \t]{1,4}|\bdocker[ \t]{1,4}login\b${SAME_COMMAND}[ \t]-p[ \t]{1,4}` +
        String.raw`|\b(?:mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)\b${SAME_COMMAND}[ \t]-p[ \t]{1,4}` +
        String.raw`|\b(?:mysql|mysqldump|mysqladmin|mariadb|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)\b${SAME_COMMAND}[ \t]--password=)` +
        ARG_VALUE,
      'g'
    ),
    to: (m, pre, dq, sq, bare) => (bare !== undefined && PORT_MAP.test(bare) ? m : flagValue(pre, dq, sq, bare, 1, true, m))
  },
  {
    name: 'openssl-pass',
    re: new RegExp(String.raw`(?<![\w-])(-pass(?:in|out)?[ \t]{1,4})(?:"pass:([^"\n]*)"|'pass:([^'\n]*)'|pass:([^\s"'${BT}]+))`, 'g'),
    to: (m, flag, dq, sq, bare) => (bare !== undefined ? flagValue(`${flag}pass:`, undefined, undefined, bare, 1, true, m) : flagValue(flag, dq, sq, undefined, 1, true, m, 'pass:'))
  },
  { name: 'vault-login', re: new RegExp(String.raw`(\bvault[ \t]{1,4}login\b${SAME_COMMAND}[ \t](?:token=)?)s\.[A-Za-z0-9]{24}(?![A-Za-z0-9])`, 'g'), to: keepName }
]

/** Key material, not a word: a digit in it, or both cases. */
const keyLike = (s: string): boolean => /[0-9]/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s))

/*
 * The prefixes a key is known by, for a key split after its prefix
 * (`split-key`): Anthropic's and OpenAI's `sk-` and their sub-prefixes,
 * GitHub's, Slack's, npm's, GitLab's, Hugging Face's and Groq's.
 */
const SPLIT_PREFIX = String.raw`sk-(?:ant-(?:[a-z]+\d*-)?|proj-|or-v1-|svcacct-|admin-)?|gh[pousr]_|github_pat_|xox[abprse]-|xapp-|npm_|glpat-|hf_|gsk_`

/*
 * What may split a key after its prefix (`split-key`): any Unicode space or
 * line break, 1–4 of them (a no-break space, U+2028/2029, an ideographic
 * space; `\s` holds them all), or a line break and what a wrapped or quoted
 * line starts with — its indent, a reply's `> ` (review of 10b0840: a tool's
 * output wrapped under five spaces, and a quoted reply, both left the halves).
 * Every count is bounded, so a run of spaces with no key after it costs a
 * fixed number of tries.
 */
const SPLIT_SEP = String.raw`(?:[ \t]{0,4}\r?\n(?:[ \t\u00a0\u3000]{0,16}>){0,4}[ \t\u00a0\u3000]{0,16}|\s{1,4})`

/** A cookie that names a session, and its value: `sessionid`, `session`, `connect.sid`, `_myapp_session`, `next-auth.session-token`, `PHPSESSID`, `JSESSIONID`. */
const COOKIE_SESSION = /(^|[\s;'"])((?:[\w.-]{0,64}[_.-])?[Ss]ession(?:[Ii][Dd]|[-_.]?[Tt]oken)?|connect\.sid|PHPSESSID|JSESSIONID)=([^;\s"'\\,]+)/g

export const SECRET_RULES: readonly SecretRule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, to: REDACTED },
  // A key cut before its END line: a message past the size cap, a first prompt, a partial paste.
  { name: 'private-key-cut', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{16,})+/g, to: REDACTED },
  // An armored PGP private key, to its END line or, cut before one, to the end of the text: its armor headers and checksum line are no base64 run.
  { name: 'pgp-private-key', re: /-----BEGIN PGP (?:PRIVATE|SECRET) KEY BLOCK-----(?:[\s\S]*?-----END PGP (?:PRIVATE|SECRET) KEY BLOCK-----|[\s\S]*)/g, to: REDACTED },
  /*
   * A key split after its prefix by a line break or a space: a terminal's
   * wrap, or a stored bare `\r` that shaping made a space (review of 166e84f).
   * `sk-ant-api03-` alone is no key to the Anthropic rule and the body alone
   * none to any, so both halves left whole. A known prefix (`SPLIT_PREFIX`),
   * at most 24 more token characters (key-like when over 6: `hf_hub_download`
   * is code), a break (`SPLIT_SEP`), then a key-like run of 8+, the two 20+
   * together: both go. AWS's `AKIA`/`ASIA` then 16 with a digit.
   */
  {
    name: 'split-key',
    re: new RegExp(String.raw`\b(?:${SPLIT_PREFIX})([A-Za-z0-9_-]{0,24})${SPLIT_SEP}([A-Za-z0-9_-]{8,})|\bA[KS]IA${SPLIT_SEP}(?=[A-Z]{0,15}[0-9])[0-9A-Z]{16}(?![0-9A-Za-z])`, 'g'),
    to: (m, piece, rest) => (piece === undefined || ((piece.length <= 6 || keyLike(piece)) && keyLike(rest) && piece.length + rest.length >= 20) ? REDACTED : m)
  },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, to: REDACTED },
  { name: 'openai', re: /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, to: REDACTED },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, to: REDACTED },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: REDACTED },
  /*
   * An access key id — AKIA (long-term), ASIA (temporary, from STS) — and a
   * 40-character secret straight after it, as a pair is pasted (`id|secret`,
   * `id:secret`, `id secret`).
   */
  { name: 'aws', re: /\bA[KS]IA[0-9A-Z]{16}\b(?:[|:,;\s]{1,3}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))?/g, to: REDACTED },
  // Slack's bot, user, app-level (`xapp-`) and rotation (`xoxe-`, `xoxe.xoxp-`) tokens.
  { name: 'slack', re: /\b(?:xox[abprse](?:\.xox[bp])?|xapp)-[A-Za-z0-9-]{10,}/g, to: REDACTED },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}/g, to: REDACTED },
  // Google's OAuth client secret (`GOCSPX-` + 28) and access token (`ya29.` + a long base64url body).
  { name: 'google-oauth', re: /\b(?:GOCSPX-[A-Za-z0-9_-]{24,}|ya29\.[A-Za-z0-9_-]{30,})/g, to: REDACTED },
  // Groq: `gsk_` + 52.
  { name: 'groq', re: /\bgsk_[A-Za-z0-9]{40,}/g, to: REDACTED },
  // HashiCorp Vault's service, batch and recovery tokens (`hvs.`, `hvb.`, `hvr.`, 90+ after them).
  { name: 'vault', re: /\bhv[sbr]\.[A-Za-z0-9_-]{24,}/g, to: REDACTED },
  // Stripe's secret and restricted keys; the publishable `pk_` is public by design.
  { name: 'stripe', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, to: REDACTED },
  // A Stripe webhook's signing secret (`whsec_` + 32 base62, or 64 hex from `stripe listen`).
  { name: 'stripe-webhook', re: /\bwhsec_[A-Za-z0-9+/]{24,}={0,2}/g, to: REDACTED },
  // Notion's integration tokens: `secret_` (43 after it) and the newer `ntn_`.
  { name: 'notion', re: /\b(?:secret_[A-Za-z0-9]{40,}|ntn_[A-Za-z0-9]{30,})/g, to: REDACTED },
  // ClickUp's personal token: `pk_<user id>_<32 upper-case letters and digits>`.
  { name: 'clickup', re: /\bpk_[0-9]{2,}_[A-Z0-9]{20,}\b/g, to: REDACTED },
  // Cloudflare's scannable credentials (2026): cfk_ (global key), cfut_/cfat_ (tokens), cfast_ (Access service token); 40 + a checksum.
  { name: 'cloudflare', re: /\bcf(?:k|ut|at|ast)_[A-Za-z0-9]{40,}/g, to: REDACTED },
  // SendGrid: `SG.` + 22 + `.` + 43, base64url.
  { name: 'sendgrid', re: /\bSG\.[\w-]{16,}\.[\w-]{16,}/g, to: REDACTED },
  // Mapbox: `sk.` (secret), `pk.` (public, still an account's) and `tk.` (temporary), each a JWT-like body.
  { name: 'mapbox', re: /\b[spt]k\.eyJ[\w-]+\.[\w-]+/g, to: REDACTED },
  { name: 'gitlab', re: /\bglpat-[\w-]{20,}/g, to: REDACTED },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g, to: REDACTED },
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, to: REDACTED },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, to: REDACTED },
  /*
   * An `Authorization` header's credentials (`Proxy-Authorization` too, any
   * case, `AUTHORIZATION` too, escaped JSON's `\"Authorization\": \"Bearer …`):
   * a Bearer, Token or Bot (Discord's) value of 20+ token characters with a
   * digit in it (a word-only `YOUR_ACCESS_TOKEN_HERE` is a placeholder), or
   * Basic's base64 of 16+. A JWT or a shaped key the rules above took reads
   * `[redacted]` and is not a token any more.
   */
  {
    name: 'authorization',
    re: /((?:[Aa]uthorization|AUTHORIZATION)(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?(?:[Bb]earer|[Tt]oken|[Bb]ot|BEARER|TOKEN|BOT)[ \t]+)(?=[A-Za-z_.~+/-]*[0-9])[\w.~+/-]{20,}=*|((?:[Aa]uthorization|AUTHORIZATION)(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?(?:[Bb]asic|BASIC)[ \t]+)[A-Za-z0-9+/]{16,}={0,2}/g,
    to: (_m, bearer, basic) => `${bearer ?? basic}${REDACTED}`
  },
  /*
   * An AWS secret access key: 40 base64 characters after a name that says so
   * (`aws_secret_access_key`, `AWS_SECRET_ACCESS_KEY`, `SecretAccessKey`), and
   * markdown's escaped `aws\_secret\_access\_key` — six of the seven in a real
   * index's copy were written that way.
   */
  {
    name: 'aws-secret',
    re: /((?:aws\\?_secret\\?_access\\?_key|AWS\\?_SECRET\\?_ACCESS\\?_KEY|[Ss]ecretAccessKey)(?:\\?["'])?[ \t]{0,4}(?::|=>|=)[ \t]{0,4}(?:\\?["'])?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
    to: keepName
  },
  // `scheme://user:pass@host`: the scheme and host stay, the user and password go.
  // The match starts at the `://` (the scheme is a lookbehind), so the engine scans for a literal, not a class.
  { name: 'credential-url', re: /(?<=\b[A-Za-z][A-Za-z0-9+.-]{1,30}):\/\/[^\s:@/?#'"<>]*:[^\s@/?#'"<>]+@(?=[A-Za-z0-9[])/g, to: `://${REDACTED}@` },
  // A Slack incoming webhook: the path after `services/` is the credential. A docs placeholder (`XXXX…`, no digit) is not one.
  { name: 'slack-webhook', re: /(hooks\.slack\.com\/services\/)T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/(?=[A-Za-z]{0,63}[0-9])(?=[0-9]{0,63}[A-Za-z])[A-Za-z0-9]{16,}/g, to: keepName },
  // A Discord webhook: the id and the token after `webhooks/` are the credential.
  { name: 'discord-webhook', re: /(discord(?:app)?\.com\/api\/webhooks\/)\d{17,20}\/[A-Za-z0-9_-]{60,}/g, to: keepName },
  // An Azure storage or Service Bus connection string's key (`AccountKey=`, `SharedAccessKey=`): base64 of 40+.
  { name: 'azure', re: /((?:Account|SharedAccess)Key=)[A-Za-z0-9+/]{40,}={0,2}/g, to: keepName },
  // An Azure SAS token's signature in a URL query (`?sv=…&sig=…`, `&amp;sig=` in HTML): URL-encoded base64 of 20+.
  { name: 'azure-sas', re: /((?<=[?&;])sig=)[A-Za-z0-9%+/=]{20,}/g, to: keepName },
  // Laravel's application key: `APP_KEY=base64:` + 44.
  { name: 'laravel-key', re: /(\bAPP_KEY[ \t]*=[ \t]*["']?)base64:[A-Za-z0-9+/]{40,}={0,2}/g, to: keepName },
  /*
   * A Telegram bot token: the bot's id, a colon, 35 base64url characters — on
   * its own, after `bot` (its Bot API URL's `/bot<id>:<token>/getMe`, a log's
   * `bot<id>:<token>`), and with the colon percent-encoded (`%3A`).
   */
  { name: 'telegram', re: /(?:(?<=\bbot)|(?<![\w:%]))\d{8,12}(?::|%3[Aa])[A-Za-z0-9_-]{35}(?![\w-])/g, to: REDACTED },
  /*
   * A `Cookie:` or `Set-Cookie:` header (and a headers object's `cookie:`):
   * a cookie that names a session (`COOKIE_SESSION`), when its value is a
   * literal of 16+. Other cookies stay: a theme, a consent flag, an id.
   */
  {
    name: 'cookie',
    re: /((?<![\w-])(?:[Ss]et-[Cc]ookie|SET-COOKIE|[Cc]ookie|COOKIE)(?:\\?["'])?[ \t]*:)([^\n]*)/g,
    to: (_m, head, rest) => head + rest.replace(COOKIE_SESSION, (m: string, pre: string, name: string, v: string) => (literalSecret(v, false, 16, true) ? `${pre}${name}=${REDACTED}` : m))
  },
  /*
   * A `.pgpass` line, `host:port:database:user:password`, whole on its own
   * line: the password goes. The host holds a letter, a dot or `*` (a
   * timestamp's `2024:10:03:12:30` has none), the port is 4–5 digits or `*`
   * (`app.ts:12:5:…` is a line and a column).
   */
  {
    name: 'pgpass',
    re: /(^|\n)([ \t]{0,8}([\w.*-]{1,253}):(?:\d{4,5}|\*):[\w.*-]{1,63}:[\w.*@-]{1,63}:)(\S+)(?=\r?\n|$)/g,
    to: (m, nl, head, host, pw) => (/[A-Za-z.*]/.test(host) && literalSecret(pw, false, 1, true) ? `${nl}${head}${REDACTED}` : m)
  },
  // PHP's `print_r` of a credential: `[password] => X`, `[db_pass] => X`, `[api_key] => X`, to the end of its line.
  {
    name: 'print-r',
    re: /(\[(?:[\w-]{0,64}_)?(?:password|passwd|passphrase|pass|pwd|secret|api_?key|private_?key|token)\][ \t]{0,4}=>[ \t]{0,4})([^\n]+)/g,
    to: (m, head, rest) => {
      const v = trimTail(rest, ' \t\r')
      if (v === 'Array' || /^(?:stdClass )?Object$/.test(v)) return m
      return literalSecret(v, true, /token/.test(head) ? 12 : /pass|pwd/.test(head) ? 4 : 8, true) ? `${head}${REDACTED}${rest.slice(v.length)}` : m
    }
  },
  ...COMMAND_LINE_RULES,
  /*
   * `password`, `passwd`, `passphrase`, `pwd`, and whatever is glued in front
   * of them stays outside the match (`PGPASSWORD`, `dbPassword`, `DB_PWD`,
   * `GPG_PASSPHRASE`, `spring.datasource.password`): a leading
   * `[A-Za-z0-9_.-]*` made each of these two rules cost three times all the
   * others together, measured on a real index. A shell's `PWD=/a/path` and
   * `OLDPWD=…` are paths, which `literalSecret` leaves. The same holds for the
   * client secret and token rules: `GOOGLE_CLIENT_SECRET`, `access_token`,
   * `refreshToken`, `GITHUB_TOKEN` all end in the name the rule looks for.
   */
  keyed('password', String.raw`[Pp]ass(?:word|wd|phrase)|PASS(?:WORD|WD|PHRASE)|[Pp]wd|PWD`, 4, { dottedAssign: true }),
  /*
   * `pass`, `DB_PASS`, `smtp.pass`, `"pass":`, `user=x pass=y`: the password
   * rule's test, but only as a word of its own or after `_`, `-` or `.`
   * (`bypass`, `compass` and `renderPass` are not one); with a colon, never
   * straight after a word and a space (prose: "the integration pass: a/b
   * measurements", measured in a real index's copy) nor as a bare `PASS:` (a
   * test runner's); and a value of letters or digits only is a word or a
   * count unless written as a shell assignment (`{ pass: 'PASS', fail: 3 }`;
   * `DB_PASS=hunter` is one).
   */
  keyed(
    'pass',
    String.raw`(?<![A-Za-z0-9])(?<![A-Za-z0-9][ \t]{1,16})[Pp]ass|(?<=[A-Za-z0-9][ \t]{1,16})[Pp]ass(?=[ \t]{0,4}=)|(?<=[A-Za-z0-9][_.-])PASS|(?<![A-Za-z0-9])PASS(?=[ \t]{0,4}=)`,
    4,
    { dottedAssign: true, plainIsCode: true }
  ),
  keyed('api-key', String.raw`[Aa][Pp][Ii]\\?[_-]?[Kk][Ee][Yy]`, 8),
  keyed('client-secret', String.raw`[Cc]lient\\?[_-]?[Ss]ecret|CLIENT\\?[_-]?SECRET`, 12),
  /*
   * `secret`, and every name that ends in it (`NEXTAUTH_SECRET`, `JWT_SECRET`,
   * `appSecret`), with a credential's suffix (`SECRET_KEY`, `SECRET_KEY_BASE`,
   * `secret_access_key` — R2's 64 hex, past the AWS rule's 40 — and
   * `SECRET_TOKEN`), and a private key's own name
   * (`PRIVATE_KEY=0x…`, `privateKey: "…"`): a literal of 8+. Code says these
   * with a type or a lookup on the right (`secret: Uint8Array`,
   * `privateKey: process.env.KEY`), which `literalSecret` leaves; the PEM rules
   * above have already taken a whole key block. `SECRET_NAME`, `SECRET_ARN`
   * and `SECRET_ID` name where a secret is, and `SECRET_VALUE` was an
   * attribute's name in every place it was measured; none is taken.
   */
  keyed(
    'secret',
    String.raw`[Ss]ecret(?:\\?[_-]?(?:[Aa]ccess\\?[_-]?)?[Kk]ey(?:\\?[_-]?[Bb]ase)?|\\?[_-]?[Tt]oken)?|SECRET(?:\\?_?(?:ACCESS\\?_?)?KEY(?:\\?_?BASE)?|\\?_?TOKEN)?|[Pp]rivate\\?[_-]?[Kk]ey|PRIVATE\\?_?KEY`,
    8
  ),
  /*
   * `token`, `access_token`, `refreshToken`, `GITHUB_TOKEN`: only a literal of
   * 12+, which keeps counts, ids and code's short names out (`eos_token: 2`,
   * `token = tok`); `max_tokens` never matches, as the name must end at `=`/`:`.
   */
  keyed('token', String.raw`[Tt]oken|TOKEN`, 12)
]

export function redactSecrets(text: string): string {
  let out = text
  for (const r of SECRET_RULES) out = typeof r.to === 'string' ? out.replace(r.re, r.to) : out.replace(r.re, r.to as (m: string, ...g: string[]) => string)
  return out
}

/*
 * C0 controls other than tab and newline, DEL, and the C1 range. Two of them
 * are the snippet marks (`HIT_OPEN`/`HIT_CLOSE`), which must never occur in
 * stored text or a snippet could not be told from a hit.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** What `cleanText` puts where it cut a text at its byte cap. */
export const CUT_MARK = ' …'

/**
 * Text as it is stored: controls gone, blobs gone, credentials gone (when
 * asked), blank-line runs squeezed, cut at `maxBytes` on a character boundary.
 * Empty when nothing searchable is left.
 */
export function cleanText(raw: string, opts: { redact: boolean; maxBytes?: number }): string {
  // Invisible characters inside a word go before any pattern judges it: a reader sees one word there, and so must the patterns.
  let t = dropInvisible(raw.replace(CONTROLS, ''))
  if (t.includes(HIT_OPEN) || t.includes(HIT_CLOSE)) t = t.split(HIT_OPEN).join('').split(HIT_CLOSE).join('')
  t = t.replace(DATA_URL, '[data]').replace(BASE64_RUN, (run) => (looksLikeBlob(run) ? '[data]' : run))
  if (opts.redact) t = redactSecrets(t)
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  const max = opts.maxBytes ?? MESSAGE_MAX_BYTES
  if (Buffer.byteLength(t, 'utf8') > max) t = cutBytes(t, max) + CUT_MARK
  return t
}

/** A run with no space of at least this many characters is shaped like a token: a key, or what a cut left of one. */
const TOKEN_TAIL_MIN = 8

/**
 * `text` with its last word made `[redacted]` when that word is shaped like a
 * token (no space in it, `TOKEN_TAIL_MIN` characters or more); a shorter one
 * stays. For text that was CUT right after that word: whatever the cut left
 * of a key is no key to any pattern — `ghp_Ab1Cd2Ef3Gh4Ij5Kl` is too short for
 * the GitHub rule, and the first 17 characters of one all the same. Text
 * stored with redaction on was cleaned whole before its cut, so it never
 * needs this; text stored raw, or under an older rule set, is cleaned again
 * only AFTER its cut (`ChatStore.recleanChat`), and does. `[redacted]` is
 * itself token-shaped, so this is a fixed point.
 */
export function redactCutTail(text: string): string {
  let start = text.length
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  return text.length - start >= TOKEN_TAIL_MIN ? text.slice(0, start) + REDACTED : text
}

/** `text` stored at a cap `cleanText` marked: its tail before the mark through `redactCutTail`; anything else as it is. */
export function redactMarkedCut(text: string): string {
  return text.endsWith(CUT_MARK) ? redactCutTail(text.slice(0, -CUT_MARK.length)) + CUT_MARK : text
}

/** The `…` a tool ends a title it cut with, a space before it or none. */
const TOOL_CUT = /[ \t]?…$/

/** A title a tool cut and marked `…` (`TOOL_CUT`): the word before the mark through `redactCutTail`; anything else as it is. */
export function redactToolCut(title: string): string {
  const m = TOOL_CUT.exec(title)
  return m ? redactCutTail(title.slice(0, m.index)) + title.slice(m.index) : title
}

/**
 * A title the tool cut itself, inside a word (review of 10b0840): Cline's
 * `metadata.title` is its prompt's first 119 characters and a `…`, cut
 * wherever the 119th fell, and `clineMeta` took it as it was — so a key the
 * cut ran through kept its first part, which no pattern knows, as the
 * title. A title that ends in `…` and, without it, is the opening of
 * `prompt` that the prompt carries on INSIDE a word, is such a cut: its last
 * word goes the way `redactCutTail` sends it. Any other title is the tool's
 * own words, kept.
 */
export function toolCutTitle(title: string, prompt: string | null): string {
  const m = TOOL_CUT.exec(title)
  if (!m || prompt === null) return title
  const norm = (t: string): string => dropInvisible(t).replace(/\s+/g, ' ').trim()
  const head = norm(title.slice(0, m.index))
  const p = norm(prompt)
  if (!head || p.length <= head.length || !p.startsWith(head) || p[head.length] === ' ') return title
  return redactToolCut(title)
}

/*
 * A long run is a blob only if it mixes cases and digits the way base64 does.
 * A 200-character identifier of one case (a hash, a long snake_case name) is
 * something a person might search for and is kept.
 */
function looksLikeBlob(run: string): boolean {
  const upper = /[A-Z]/.test(run)
  const lower = /[a-z]/.test(run)
  const digit = /[0-9]/.test(run)
  return (upper && lower && digit) || run.length >= 1000
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never splitting a character. */
export function cutBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  let end = max
  // Back off continuation bytes (10xxxxxx) so the cut lands on a lead byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** An epoch (seconds or ms) or an ISO string, as ms; null when it is neither. */
export function stamp(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** Widen a chat's first and last stamps to take in `at`. */
export function note(meta: ChatMeta, at: number | null): void {
  if (at === null) return
  if (meta.createdMs === null || at < meta.createdMs) meta.createdMs = at
  if (meta.updatedMs === null || at > meta.updatedMs) meta.updatedMs = at
}

/** A first prompt's length at most, in UTF-16 units. */
export const FIRST_PROMPT_MAX = 300

/**
 * A chat's first prompt: one line, at most `FIRST_PROMPT_MAX`, and when it is
 * cut, cut back to its last space — never inside a word. A Cline chat with no
 * title takes this of its RAW prompt as its title and cleans it only after
 * (`clineMeta`, `mergeMeta`), so a cut inside a key kept the key's first part
 * whole past every pattern (re-review of 62b4ae6). A cut one is therefore
 * shorter than the cap unless it is one long word, which is what
 * `recleanChat` reads a first prompt AT the cap as: cut inside a word.
 */
export function firstPromptOf(text: string): string {
  return firstPromptCut(text).text
}

/**
 * `firstPromptOf` for text no pattern has judged yet — a Cline prompt that
 * stands in for a title, Codex's `first_user_message` — which is cleaned only
 * after the cut. A cut that had to land inside a word (one word past the cap,
 * no space to cut back to) makes that word `[redacted]` (`redactCutTail`),
 * never leaves a part of a key there (review of 166e84f).
 */
export function rawFirstPromptOf(text: string): string {
  const c = firstPromptCut(text)
  return c.inWord ? redactCutTail(c.text) : c.text
}

function firstPromptCut(text: string): { text: string; inWord: boolean } {
  // Invisible characters first: `\s` takes a byte order mark as a space, which split a key in two words before `cleanText` could join it.
  const t = dropInvisible(text).replace(/\s+/g, ' ').trim()
  if (t.length <= FIRST_PROMPT_MAX) return { text: t, inWord: false }
  const cut = t.slice(0, FIRST_PROMPT_MAX)
  const space = cut.lastIndexOf(' ')
  return space > 0 ? { text: cut.slice(0, space), inWord: false } : { text: cut, inWord: true }
}

/** One message, cleaned (`cleanText`); nothing when no text is left. The first user message is the first prompt. */
export function push(fold: Fold, role: 'user' | 'assistant', raw: string, at: number | null, redact: boolean): void {
  const text = cleanText(raw, { redact })
  if (!text) return
  fold.messages.push({ role, text, atMs: at })
  if (role === 'user' && fold.meta.firstPrompt === null) fold.meta.firstPrompt = firstPromptOf(text)
}

/* ---------------------------------------------------------- Claude Code */

/*
 * The cheap test in front of JSON.parse, the same trick `scanText` uses: a
 * record worth parsing must contain one of these. Measured: 33,750 of 69,896
 * Claude lines parsed.
 */
export function claudeLineWorthParsing(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('ai-title')
}

/**
 * Fold one Claude Code transcript line (Cowork's are the same format).
 *
 * Skipped, as `readTranscript` skips them: sidechain records (a subagent's,
 * not the user's thread), meta records (Stoke and the CLI talking), a user
 * record carrying a tool_result (a tool's output fed back), local-command
 * noise, and the CLI's "[Request interrupted" notes. From an assistant record
 * only its `text` blocks: thinking and tool_use are not conversation.
 *
 * `subagentFile` is for a transcript under `<session>/subagents/`, listed
 * only while "Include subagent chats" is on. EVERY record in one of those is
 * `isSidechain: true` — measured on the machine this was fixed on, 7,378 of
 * 7,378 user and assistant records across 52 files — because the whole file
 * is the subagent's thread. Skipping sidechains there indexed nothing at all:
 * every subagent transcript became an empty chat row that still took a slot
 * under the caps. In a subagent's own file the sidechain IS the conversation.
 *
 * The folder is the FIRST cwd a user record carries — where the session was
 * started, the folder its transcript is filed under, and what `projects.ts`'s
 * `cwdFromTranscript` and the session list use. A `cd` during the session
 * moves later records' cwd; resuming from there is not the same session's
 * folder (the CLI refuses a conversation "from a different directory").
 */
export function foldClaudeLine(fold: Fold, line: string, redact: boolean, subagentFile = false): void {
  if (!claudeLineWorthParsing(line)) return
  const rec = safeParse(line)
  if (!rec) return
  if (rec.type === 'ai-title') {
    const t = titleOf(rec)
    if (t) fold.meta.title = cleanText(t, { redact, maxBytes: 1024 })
    return
  }
  if (rec.type !== 'user' && rec.type !== 'assistant') return
  if ((rec.isSidechain === true && !subagentFile) || rec.isMeta === true) return
  const at = stamp(rec.timestamp)
  note(fold.meta, at)
  const msg = rec.message as { content?: unknown; model?: unknown } | undefined
  const content = msg?.content
  if (rec.type === 'user') {
    if (typeof rec.cwd === 'string' && rec.cwd && fold.meta.cwd === null) fold.meta.cwd = rec.cwd
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) fold.meta.gitBranch = rec.gitBranch
    if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result')) return
    const text = textOf(content)?.trim() ?? ''
    if (!text || !isUsefulPrompt(text) || text.startsWith('[Request interrupted')) return
    push(fold, 'user', text, at, redact)
    return
  }
  if (typeof msg?.model === 'string' && msg.model && msg.model !== '<synthetic>') fold.meta.model = msg.model
  const text = textOf(content)?.trim() ?? ''
  if (text) push(fold, 'assistant', text, at, redact)
}

/* ------------------------------------------------------------------ Codex */

export function codexLineWorthParsing(line: string): boolean {
  return line.includes('"type":"message"') || line.includes('"session_meta"') || line.includes('"turn_context"')
}

/*
 * A block Codex put in the user's turn on their behalf: `<environment_context>`,
 * `<user_instructions>`, `<recommended_plugins>` and the like — one element
 * from start to end — or the AGENTS.md preamble. Measured on this machine's
 * rollouts, every non-plain user block had that shape.
 */
const WRAPPED_BLOCK = /^<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/

export function isInjectedBlock(text: string): boolean {
  const t = text.trim()
  return WRAPPED_BLOCK.test(t) || t.startsWith('# AGENTS.md') || t.startsWith('<environment_context>')
}

/**
 * Fold one Codex rollout line. User and assistant `message` items only — the
 * `event_msg` copies of the same turns are skipped so nothing is indexed
 * twice — and `developer` turns never. `session_meta` gives the folder, the
 * start time, and whether the thread is a subagent's (`source.subagent`).
 * The folder is the first one seen, as for Claude: a later `turn_context`
 * that moved does not move where the thread started.
 */
export function foldCodexLine(fold: Fold, line: string, redact: boolean): void {
  if (!codexLineWorthParsing(line)) return
  const rec = safeParse(line)
  if (!rec) return
  const p = (rec.payload ?? {}) as Record<string, unknown>
  const at = stamp(rec.timestamp)
  if (rec.type === 'session_meta') {
    if (typeof p.cwd === 'string' && p.cwd && fold.meta.cwd === null) fold.meta.cwd = p.cwd
    const started = stamp(p.timestamp)
    if (started !== null) note(fold.meta, started)
    const src = p.source
    if (src && typeof src === 'object' && 'subagent' in (src as object)) fold.subagent = true
    return
  }
  if (rec.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) fold.meta.model = p.model
    if (typeof p.cwd === 'string' && p.cwd && fold.meta.cwd === null) fold.meta.cwd = p.cwd
    return
  }
  if (rec.type !== 'response_item' || p.type !== 'message') return
  if (p.role !== 'user' && p.role !== 'assistant') return
  const blocks = Array.isArray(p.content) ? (p.content as Record<string, unknown>[]) : []
  const parts: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type !== 'input_text' && b.type !== 'output_text' && b.type !== 'text') continue
    const t = typeof b.text === 'string' ? b.text : ''
    if (!t.trim()) continue
    if (p.role === 'user' && isInjectedBlock(t)) continue
    parts.push(t)
  }
  if (parts.length === 0) return
  note(fold.meta, at)
  push(fold, p.role, parts.join('\n'), at, redact)
}

/* --------------------------------------------------------------- OpenCode */

/**
 * One OpenCode `part.data` document: its text when it is a `text` part the
 * user or the model wrote. `synthetic` parts are OpenCode's own injections.
 */
export function opencodePartText(data: string): string | null {
  let p: unknown
  try {
    p = JSON.parse(data)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  const r = p as { type?: unknown; text?: unknown; synthetic?: unknown }
  if (r.type !== 'text' || r.synthetic === true || typeof r.text !== 'string') return null
  return r.text
}

/** OpenCode rows (one per text part, in order) folded into messages, one per message id. */
export function foldOpencodeRows(
  rows: readonly { messageId: string; role: unknown; timeCreated: unknown; data: string }[],
  redact: boolean
): Fold {
  const fold = emptyFold()
  let current: { id: string; role: 'user' | 'assistant'; at: number | null; parts: string[] } | null = null
  const flush = (): void => {
    if (current && current.parts.length) push(fold, current.role, current.parts.join('\n'), current.at, redact)
  }
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue
    const text = opencodePartText(r.data)
    if (!text || !text.trim()) continue
    if (!current || current.id !== r.messageId) {
      flush()
      current = { id: r.messageId, role: r.role, at: stamp(r.timeCreated), parts: [] }
      note(fold.meta, current.at)
    }
    current.parts.push(text)
  }
  flush()
  return fold
}

/* ------------------------------------------------------------------ Cline */

/** Cline's names for the tools it imports from, as this index names them. */
const CLINE_ORIGINS: Record<string, ChatSourceId> = {
  codex: 'codex',
  'claude-code': 'claude',
  claude: 'claude',
  opencode: 'opencode'
}

export interface ClineMeta {
  title: string | null
  cwd: string | null
  createdMs: number | null
  updatedMs: number | null
  gitBranch: string | null
  model: string | null
  /** `codex:<id>` when this session is Cline's imported copy of another tool's chat. */
  dedupeKey: string | null
}

/**
 * A Cline session's `<id>.json`. Only named fields are read. `importedFrom`
 * says which tool's chat this is a copy of (`tool`, `sourceSessionId`), which
 * is how the copy is folded into its original rather than listed twice.
 */
export function clineMeta(doc: unknown): ClineMeta {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  const md = d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, unknown>) : {}
  const imp = md.importedFrom && typeof md.importedFrom === 'object' ? (md.importedFrom as Record<string, unknown>) : null
  const git = md.git && typeof md.git === 'object' ? (md.git as Record<string, unknown>) : {}
  const origin = imp && typeof imp.tool === 'string' ? CLINE_ORIGINS[imp.tool] : undefined
  const originId = imp && typeof imp.sourceSessionId === 'string' ? imp.sourceSessionId : ''
  const prompt = typeof d.prompt === 'string' && d.prompt.trim() ? d.prompt : null
  // Cline's own title is its prompt cut at 119 characters, inside a word, and a `…` (`toolCutTitle`); with none, the RAW prompt's opening stands in.
  const title = typeof md.title === 'string' && md.title.trim() ? toolCutTitle(md.title.trim(), prompt) : prompt !== null ? rawFirstPromptOf(prompt) : null
  return {
    title,
    cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : typeof d.workspace_root === 'string' && d.workspace_root ? d.workspace_root : null,
    createdMs: stamp(d.started_at),
    updatedMs: stamp(d.ended_at) ?? stamp(d.started_at),
    gitBranch: typeof git.branch === 'string' ? git.branch : null,
    model: typeof d.model === 'string' ? d.model : null,
    dedupeKey: origin && originId ? `${origin}:${originId}` : null
  }
}

/** Cline wraps what it tells the model about the workspace in these; they are not the user's words. */
const CLINE_INJECTED = /<environment_details>[\s\S]*?<\/environment_details>/g

/** A Cline `<id>.messages.json`: `{ messages: [{ role, content: [blocks], ts }] }`. Text blocks only. */
export function foldClineMessages(doc: unknown, redact: boolean): Fold {
  const fold = emptyFold()
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  const list = Array.isArray(doc) ? doc : Array.isArray(d.messages) ? d.messages : []
  for (const m of list as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const content = m.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const parts: string[] = []
    for (const b of blocks as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object' || b.type !== 'text' || typeof b.text !== 'string') continue
      const t = b.text.replace(CLINE_INJECTED, '').trim()
      if (!t || (m.role === 'user' && isInjectedBlock(t))) continue
      parts.push(t)
    }
    if (!parts.length) continue
    const at = stamp(m.ts)
    note(fold.meta, at)
    push(fold, m.role, parts.join('\n'), at, redact)
  }
  return fold
}

/* -------------------------------------------------------------------- Zed */

/**
 * A Zed agent thread, zstd-decompressed JSON: `messages` of `{User: {content}}`
 * or `{Agent: {content}}`, whose content blocks are `{Text}`, `{Thinking}`,
 * `{ToolUse}`, `{Mention}`… — only `Text` is words.
 */
export function foldZedThread(doc: unknown, redact: boolean): Fold {
  const fold = emptyFold()
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  if (typeof d.title === 'string' && d.title.trim()) fold.meta.title = cleanText(d.title, { redact, maxBytes: 1024 })
  const model = d.model && typeof d.model === 'object' ? (d.model as Record<string, unknown>).model : null
  if (typeof model === 'string') fold.meta.model = model
  if (d.subagent_context && typeof d.subagent_context === 'object') fold.subagent = true
  const updated = stamp(d.updated_at)
  note(fold.meta, updated)
  for (const m of Array.isArray(d.messages) ? (d.messages as Record<string, unknown>[]) : []) {
    if (!m || typeof m !== 'object') continue
    const role = 'User' in m ? 'user' : 'Agent' in m ? 'assistant' : null
    if (!role) continue
    const body = (m.User ?? m.Agent) as { content?: unknown } | undefined
    const blocks = Array.isArray(body?.content) ? (body.content as Record<string, unknown>[]) : []
    const parts: string[] = []
    for (const b of blocks) {
      if (b && typeof b === 'object' && typeof b.Text === 'string' && b.Text.trim()) parts.push(b.Text)
    }
    if (parts.length) push(fold, role, parts.join('\n'), updated, redact)
  }
  return fold
}

/** Zed's `folder_paths` column: one path per line, or a JSON array. The first. */
export function zedFolder(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t) as unknown
      return Array.isArray(a) && typeof a[0] === 'string' ? a[0] : null
    } catch {
      return null
    }
  }
  return t.split(/\r?\n/)[0] || null
}

/* ----------------------------------------------------------------- Cowork */

/**
 * A Cowork session's `local_<id>.json`, whitelisted. The same file carries the
 * account's name and email address; those are never read into the index —
 * which is why this names what it takes instead of spreading the document.
 */
export function coworkMeta(doc: unknown): { title: string | null; cwd: string | null; createdMs: number | null; updatedMs: number | null; archived: boolean } {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  return {
    title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : null,
    cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : null,
    createdMs: stamp(d.createdAt),
    updatedMs: stamp(d.lastActivityAt),
    archived: d.isArchived === true
  }
}

/* ----------------------------------------------------------------- trims */

/**
 * Which messages to drop so a chat's text fits `capBytes`: keep the first
 * three quarters of the budget from the start of the chat and the rest from
 * its end, and drop the middle. `sizes` is each message's byte size in order;
 * the answer is indices into it. Empty when it already fits.
 */
export function planTrim(sizes: readonly number[], capBytes: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= capBytes) return []
  const headBudget = Math.floor(capBytes * 0.75)
  let head = 0
  let i = 0
  while (i < sizes.length && head + sizes[i] <= headBudget) head += sizes[i++]
  let tail = 0
  let j = sizes.length - 1
  while (j >= i && head + tail + sizes[j] <= capBytes) tail += sizes[j--]
  const drop: number[] = []
  for (let k = i; k <= j; k++) drop.push(k)
  return drop
}
