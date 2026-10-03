/*
 * Chat history: every source's reader, the caps and what they say, the store,
 * incremental reads, Cline's duplicate fold, search and its snippets, and the
 * worker the main process talks to — all against SYNTHETIC fixtures in a temp
 * directory. Never the real ~/.claude, ~/.codex or any app's data: every root
 * is resolved from a fake home (`SourceEnv`), and the store is a temp userData.
 *
 * Gotcha 74 is the reason for the shape: a suite that fakes a clock or a cap
 * must fake the paths too, and must show that a bystander beside what it
 * deletes survives. Here the fake home holds a bystander next to the
 * transcripts, and the fake userData holds one next to the store that
 * "Delete index" removes.
 *
 *   node scripts/verify-chat-sources.mts
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import {
  CHAT_CAP_DEFAULTS,
  CHAT_EXPORT_LIMITS,
  CHAT_INDEX_DEFAULTS,
  CHAT_PRESETS,
  chatOpenAction,
  clampChatCaps,
  clampChatIndex,
  clampChatIndexOptions,
  emptyChatStatus,
  ftsQuery,
  highlightRanges,
  HIT_CLOSE,
  HIT_OPEN,
  importDisclosure,
  offerFound,
  parseMarked,
  presetOf,
  sourceDisclosure,
  type ChatImportRecord,
  type ChatIndexOptions,
  type ChatOrigin,
  type ChatSourceStatus
} from '../src/shared/chatIndex.ts'
import { agentLaunchPlan, DEFAULT_ENDPOINT } from '../src/shared/agents.ts'
import { isSafeResumeId, resumableClis, type CodingCliId } from '../src/shared/codingClis.ts'
import { cleanText, cutBytes, planTrim } from '../src/main/chatIndex/parse.ts'
import { ChatStore } from '../src/main/chatIndex/store.ts'
import { mergeMeta, recleanStale, runPass, type PassHooks } from '../src/main/chatIndex/scan.ts'
import {
  claudeRoots,
  codexHome,
  coworkRoot,
  detectSource,
  discovery,
  listSource,
  opencodeDbPath,
  setDiscoveryLimitForTest,
  zedDbPath,
  DISCOVERY_MAX_ENTRIES,
  type SourceEnv
} from '../src/main/chatIndex/sources.ts'
import { ChatIndexHost } from '../src/main/chatIndex/host.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { closeZip, openZip, readZipEntry, ZipError, type ZipLimits } from '../src/main/chatIndex/zip.ts'
import { forEachArrayObject, foldChatgptConversation, foldClaudeAiConversation } from '../src/main/chatIndex/exports.ts'
import { importExport, type ImportHooks } from '../src/main/chatIndex/importer.ts'
import { openChat, openChatCleaned } from '../src/main/chatIndex/viewer.ts'
import { crc32, deflateRawSync } from 'node:zlib'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------ pure rules */

section('settings: hydrated and clamped')
{
  const fresh = hydrateSettings({})
  check('a settings file with no key reads as never asked (the offer shows once)', fresh.chatIndex, 'unasked')
  check('only the two literals are answers', [clampChatIndex('on'), clampChatIndex('off'), clampChatIndex(true), clampChatIndex('yes')], [
    'on',
    'off',
    'unasked',
    'unasked'
  ])
  check('the defaults: every source on, subagents off, redaction on, Standard caps', fresh.chatIndexOptions, CHAT_INDEX_DEFAULTS)
  const junk = clampChatIndexOptions({ sources: { claude: false, codex: 'yes', bogus: true }, subagents: 'true', redact: 0, caps: { perSource: -5, total: '9e9', passMb: 'x' } })
  check('a source not literally false/true takes its default; unknown ids are dropped', [junk.sources.claude, junk.sources.codex, 'bogus' in junk.sources], [false, true, false])
  check('subagents only on for the literal true; redaction only off for the literal false', [junk.subagents, junk.redact], [false, true])
  check('caps are pulled into range, never refused', [junk.caps.perSource, junk.caps.total, junk.caps.passMb], [1, 200_000, CHAT_CAP_DEFAULTS.passMb])
  check('a hand-edited file keeps every named field (no undefined after hydrate)', Object.keys(clampChatCaps({})).sort(), Object.keys(CHAT_CAP_DEFAULTS).sort())
  check('presets are recognised, anything else is custom', [presetOf(CHAT_PRESETS.light), presetOf(CHAT_CAP_DEFAULTS), presetOf({ ...CHAT_CAP_DEFAULTS, perSource: 7 })], [
    'light',
    'standard',
    'custom'
  ])
}

section('search query and snippets')
{
  check('every word a required prefix', ftsQuery('stok sess'), '"stok"* "sess"*')
  check('a double quote can never reach FTS5 syntax', ftsQuery('a" OR b:c NEAR("x'), '"a"* "OR"* "b"* "c"* "NEAR"* "x"*')
  check('nothing searchable is null', ftsQuery('  -- ** '), null)
  check('non-ASCII words stay whole', ftsQuery('tiếng Việt 日本語'), '"tiếng"* "Việt"* "日本語"*')
  const m = parseMarked(`say ${HIT_OPEN}Việt${HIT_CLOSE} and ${HIT_OPEN}naïve${HIT_CLOSE}…`)
  check('marks become ranges over the unmarked text', [m.text, m.ranges.map(([s, e]) => m.text.slice(s, e))], ['say Việt and naïve…', ['Việt', 'naïve']])
}

section('text: what is kept')
{
  const blob = 'Zm9vYmFy' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy'.repeat(8)
  const t = cleanText(`look ${blob} here sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and ghp_abcdefghijklmnopqrstuvwxyz0123 ok`, { redact: true })
  check('a base64 run goes, the sentence around it stays', [t.includes('Zm9vYmFy'), t.startsWith('look [data] here')], [false, true])
  check('API keys are redacted', [t.includes('ABCDEFGHIJKLMNOPQRSTUV'), t.includes('abcdefghijklmnopqrstuvwxyz0123'), t.split('[redacted]').length - 1], [false, false, 2])
  check('redaction off keeps them', cleanText('key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV', { redact: false }).includes('ABCDEFGHIJKLMNOPQRSTUV'), true)
  check('a one-case long identifier is not a blob', cleanText('x'.repeat(250), { redact: true }).length, 250)
  check('the snippet marks can never be stored', cleanText(`a${HIT_OPEN}b${HIT_CLOSE}c\u0000d`, { redact: true }), 'abcd')
  check('a byte cut never splits a character', cutBytes('日本語', 4), '日')
  check('planTrim keeps the head and the tail, drops the middle', planTrim([10, 10, 10, 10, 10, 10, 10, 10], 40), [3, 4, 5, 6])
  check('planTrim leaves what fits alone', planTrim([10, 10], 40), [])
}

/*
 * Every fake credential below is BUILT when the suite runs, never written out
 * whole: this file is pushed, and a secret scanner (or GitHub's push
 * protection, which blocks a push carrying a Stripe live key's shape) cannot
 * tell a fixture from a leak.
 */
const fake = (prefix: string, n: number, alphabet = 'Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu'): string => prefix + Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('')
const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const FAKE_JWT = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: '1234567890', name: 'Fixture Person', iat: 1516239022 })}.${fake('', 43)}`
/** The signature's opening: one FTS token (letters and digits only), so a prefix search finds it while it is stored. */
const JWT_TAIL = FAKE_JWT.split('.')[2].slice(0, 16)

section('redaction: each rule takes its own shape, and leaves code and placeholders alone')
{
  const red = (s: string): string => cleanText(s, { redact: true })
  const takes = (what: string, text: string, want: string): void => check(`takes ${what}`, red(text), want)
  const leaves = (what: string, text: string): void => check(`leaves ${what}`, red(text), text)

  // credential-url: the scheme and host stay searchable.
  takes('a credential URL’s user and password', `DATABASE_URL=postgres://admin:${fake('', 12)}@db.internal:5432/app`, 'DATABASE_URL=postgres://[redacted]@db.internal:5432/app')
  takes('a token in a clone URL', `git clone https://x-access-token:${fake('', 30)}@github.com/o/r.git`, 'git clone https://[redacted]@github.com/o/r.git')
  leaves('a user with no password', 'ssh://git@github.com/o/r.git')
  leaves('an @ after a port and a path', 'http://localhost:3000/a@b and https://example.com:443/users/@me')

  // password: the name stays, a literal value goes.
  takes('password=', 'export password=Tr0ub4dor3x', 'export password=[redacted]')
  takes('a JSON password with a space in it', '{"user": "lena", "password": "c0rrect horse"}', '{"user": "lena", "password": "[redacted]"}')
  takes('a shell assignment of a plain word', 'docker run -e POSTGRES_PASSWORD=postgres pg', 'docker run -e POSTGRES_PASSWORD=[redacted] pg')
  takes('a name glued on in capitals', 'PGPASSWORD=s3cretpw psql -h db', 'PGPASSWORD=[redacted] psql -h db')
  takes('a dotted property name', 'spring.datasource.password=abc123xyz', 'spring.datasource.password=[redacted]')
  takes('pwd=', 'mysql pwd=Zq9x!long', 'mysql pwd=[redacted]')
  takes('passwd:', 'passwd: Kq7#vv21', 'passwd: [redacted]')
  takes('a camel-case name, single quotes', "dbPassword: 'hunter22'", "dbPassword: '[redacted]'")
  takes('=> and :=', `'password' => 'p4ssw0rd' and password := "g0pher!x"`, `'password' => '[redacted]' and password := "[redacted]"`)
  for (const code of [
    'password: string',
    'password=password',
    'password: process.env.DB_PASSWORD',
    'password: z.string().min(8)',
    'password = getpass()',
    'chromeKey(password: string): Buffer',
    'PWD=/Users/me/dev',
    'OLDPWD=/Users/me',
    'env: { PWD: cwd, HOME: home }',
    'DB_PASSWORD: str',
    'DB_PASSWORD=None',
    'password: ""',
    'password: "${DB_PASSWORD}"',
    'password: "*****"',
    'password_hash: "$2b$10$abcdefghijklmnopqrstuv"',
    'PW=${STOKE_SSH_PASSWORD:?set it}',
    "mode === 'up' ? 'new-password' : 'current-password'",
    'print("Password: " + pw + "!")',
    '1446:%s@%s\'s password:\\n1449:Enter'
  ]) {
    leaves(`code, a placeholder or a path: ${code}`, code)
  }

  // api-key
  takes('api_key=', 'api_key=9f8e7d6c5b4a3210', 'api_key=[redacted]')
  takes('a JSON apiKey', '{"apiKey": "k9-abcdefgh-1234"}', '{"apiKey": "[redacted]"}')
  takes('an X-API-Key header', 'curl -H X-API-Key: 0123abcd4567efgh https://x', 'curl -H X-API-Key: [redacted] https://x')
  takes('an env name ending in API_KEY', 'OPENAI_API_KEY=abc12345xyz9', 'OPENAI_API_KEY=[redacted]')
  takes('a key a shaped rule took first, once', 'api_key=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV', 'api_key=[redacted]')
  for (const code of ['apiKey: string', 'api_key=None', 'apiKey: process.env.OPENAI_API_KEY', 'PEXELS_API_KEY=...', 'apiKey: "your-api-key"', 'api_key: str | None = None', 'openrouterApiKey: OPENROUTER_KEY_2', "apiKey: '$${CUSTOM_API_KEY}'"]) {
    leaves(`code or a placeholder: ${code}`, code)
  }

  // jwt
  takes('a JWT', `Authorization: Bearer ${FAKE_JWT}`, 'Authorization: Bearer [redacted]')
  leaves('a JWT header alone', `the header ${b64url({ alg: 'none' })} decodes to that`)

  // stripe: secret and restricted keys; the publishable one is public by design.
  takes('a Stripe live secret key', `key ${fake('sk_' + 'live_', 24)} here`, 'key [redacted] here')
  takes('a Stripe restricted key', `key ${fake('rk_' + 'live_', 24)} here`, 'key [redacted] here')
  takes('a Stripe test key', `key ${fake('sk_' + 'test_', 24)} here`, 'key [redacted] here')
  leaves('a publishable key, and a docs placeholder', `${fake('pk_' + 'live_', 24)} and sk_test_xxx`)

  // notion
  takes('a Notion secret_ token', `NOTION_TOKEN ${fake('secret_', 43)}`, 'NOTION_TOKEN [redacted]')
  takes('a Notion ntn_ token', `token ${fake('ntn_', 46)}`, 'token [redacted]')
  leaves('an identifier that starts secret_', 'secret_key_base and ntn_short')

  // clickup: pk_<user id>_<32 upper-case letters and digits>
  takes('a ClickUp token', `CLICKUP ${fake('pk_81234567_', 32, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')}`, 'CLICKUP [redacted]')
  leaves('pk_ with no user id', 'pk_123_abc and pk_test')

  // cloudflare: the scannable prefixes
  for (const p of ['cfut_', 'cfat_', 'cfk_', 'cfast_']) takes(`a Cloudflare ${p} credential`, `CF ${fake(p, 48)}`, 'CF [redacted]')
  leaves('a Cloudflare API path', '/accounts/abc/cfd_tunnel/123/configurations')

  // private-key-cut: a key whose END was cut off (the message cap, a first prompt) or never pasted.
  const body = [fake('', 64), fake('', 64, 'Zy8Xw6Vu4Ts2Rq0Po9Nm7Lk5'), fake('', 40)]
  takes('a private key cut before its END line', `here:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body.join('\n')}`, 'here:\n[redacted]')
  takes('...and squeezed onto one line, as a first prompt is', `here -----BEGIN RSA PRIVATE KEY----- ${body.join(' ')} …`, 'here [redacted] …')
  leaves('the marker in a sentence', 'the file starts with -----BEGIN OPENSSH PRIVATE KEY----- and then the body')
}

/*
 * Rule set 3 (security review of db1ae51). Each block below failed under 2:
 * a dotted value was code whatever its segments, an unquoted value stopped at
 * `&`, `;` and `,` and was judged by its head alone, and the shapes after
 * those had no rule.
 */
section('redaction 3: a dotted value is code only while every segment is a name’s')
{
  const red = (s: string): string => cleanText(s, { redact: true })
  const takes = (what: string, text: string, want: string): void => check(`takes ${what}`, red(text), want)
  const leaves = (what: string, text: string): void => check(`leaves ${what}`, red(text), text)
  takes('a key with a 12+ letters-and-digits segment', 'api_key=AbC123xYz.dEf456gHi789jKl and api_key=ab.Q7XK29PLM4ZT8W', 'api_key=[redacted] and api_key=[redacted]')
  takes('a dotted .env value (an assignment: the value is literal)', 'DB_PASSWORD=correct.horse.battery9', 'DB_PASSWORD=[redacted]')
  takes('a segment with digits inside a lower-case word', 'password=p4ss.Word.xyz', 'password=[redacted]')
  takes('a dotted value in a URL query', 'https://x.io/login?password=correct.horse.staple', 'https://x.io/login?password=[redacted]')
  for (const code of [
    'apiKey: config.OPENROUTER_KEY_2',
    'password=self.password,',
    'api_key=settings.API_KEY',
    'token: req.headers.authorization',
    "apiKey: process.env.KEY||'dev'",
    'password: base64.b64decode(blob)',
    'clientSecret: keys.oauth2ClientSecret',
    'token: this.s3Bucket.token',
    'password: $this->password'
  ]) {
    leaves(`code: ${code}`, code)
  }
}

section('redaction 3: an unquoted value runs to the next space, except in a URL query or connection string')
{
  const red = (s: string): string => cleanText(s, { redact: true })
  const takes = (what: string, text: string, want: string): void => check(`takes ${what}`, red(text), want)
  const leaves = (what: string, text: string): void => check(`leaves ${what}`, red(text), text)
  takes('a value with a & in it, whole', 'DB_PASSWORD=Xy7&kL9#mQ2vP', 'DB_PASSWORD=[redacted]')
  takes('a value with a ; in it, whole', 'password: a1;Zq8$Wm4!Lp', 'password: [redacted]')
  takes('a value with a , in it, tail and all', 'api_key=9f8e7d6c,5b4a3210ffee', 'api_key=[redacted]')
  takes('a value with a quote inside a word', "DB_PASSWORD=Xy7'kL9#mQ2vP", 'DB_PASSWORD=[redacted]')
  takes('a URL query’s value, up to the next &', 'https://x.io/cb?user=me&password=hunter22&next=/home', 'https://x.io/cb?user=me&password=[redacted]&next=/home')
  takes('a connection string’s, up to the next ; (a & is the value’s)', 'Server=db;User Id=sa;Password=Xy7&kL9;Encrypt=true', 'Server=db;User Id=sa;Password=[redacted];Encrypt=true')
  takes('a query value inside a markdown link, up to the link’s end', `[![cov](https://cov.io/b.svg?token=${fake('', 20)})](https://cov.io)`, '[![cov](https://cov.io/b.svg?token=[redacted])](https://cov.io)')
  takes('structure after the value stays', '{ user: x, password: abc123xyz, b: 2 } and export PASSWORD=abc123; npm start', '{ user: x, password: [redacted], b: 2 } and export PASSWORD=[redacted]; npm start')
  takes('an escaped newline ends the value (JSON-escaped text)', 'cmd: \\"psql password: Zq8xWm4Lp\\nnext line\\"', 'cmd: \\"psql password: [redacted]\\nnext line\\"')
  takes('the rest of a value 2 cut short, once the stored text is cleaned again', 'api_key=[redacted],5b4a3210ffee', 'api_key=[redacted]')
  leaves('compact JSON’s next pair', '{"next_page_token":null},"hasMore":false}')
  leaves('an escaped placeholder', '- `api-key: &lt;key&gt;`')
  leaves('a keyword argument before an escaped newline', 'f(token=token,\\n    other=1)')
  leaves('a value already taken, with structure after it', 'password=[redacted]), {"password": "[redacted]"}, ?password=[redacted]&next=1')
}

section('redaction 3: the shapes 2 had no rule for')
{
  const red = (s: string): string => cleanText(s, { redact: true })
  const takes = (what: string, text: string, want: string): void => check(`takes ${what}`, red(text), want)
  const leaves = (what: string, text: string): void => check(`leaves ${what}`, red(text), text)
  const SG = `SG.${fake('', 22)}.${fake('', 43, 'Zy8Xw6Vu4Ts2Rq0Po9Nm7Lk5-_')}`
  takes('a SendGrid key, alone and keyed', `key ${SG} and SENDGRID_API_KEY=${SG}`, 'key [redacted] and SENDGRID_API_KEY=[redacted]')
  const MB = `sk.${b64url({ u: 'fixture', a: 'ck1' })}.${fake('', 22)}`
  takes('a Mapbox token, alone and keyed', `the map uses ${MB} and MAPBOX_API_KEY=${MB}`, 'the map uses [redacted] and MAPBOX_API_KEY=[redacted]')
  leaves('SendGrid- and Mapbox-like code', 'sg.send(msg) and SG.Mail and pk.eyJ alone')
  takes('a Bearer header', `curl -H "Authorization: Bearer ${fake('', 32)}" https://api.x`, 'curl -H "Authorization: Bearer [redacted]" https://api.x')
  takes('a Bearer token with an underscore in it', `Authorization: Bearer ${fake('', 12)}_${fake('', 12)}`, 'Authorization: Bearer [redacted]')
  takes('a lower-case header, JSON-quoted', `{"authorization": "bearer ${fake('', 40)}"}`, '{"authorization": "bearer [redacted]"}')
  takes('a Basic header', `Authorization: Basic ${Buffer.from('fixture-user:fixture-pass').toString('base64')}`, 'Authorization: Basic [redacted]')
  for (const code of ['Authorization: Bearer YOUR_ACCESS_TOKEN_HERE', 'Authorization: Bearer $TOKEN', 'Authorization: Bearer ${token}', 'Authorization: Basic base64(user:pass)', "headers: { Authorization: 'Bearer ' + token }"]) {
    leaves(`a header’s placeholder or code: ${code}`, code)
  }
  const AWS40 = fake('', 40, 'Ab3Cd5Ef7/Gh9Jk2+Mn4Pq6Rs8Tu')
  const ASIA = 'AS' + 'IA' + fake('', 16, 'ABCDEFGHJKLMNPQRSTUVWXYZ234567')
  takes('an AWS secret access key, by each name', `aws_secret_access_key = ${AWS40}\nAWS_SECRET_ACCESS_KEY=${AWS40}\n"SecretAccessKey": "${AWS40}"`, 'aws_secret_access_key = [redacted]\nAWS_SECRET_ACCESS_KEY=[redacted]\n"SecretAccessKey": "[redacted]"')
  takes('...under markdown’s escaped name', `aws\\_secret\\_access\\_key=${AWS40} here`, 'aws\\_secret\\_access\\_key=[redacted] here')
  takes('a temporary (ASIA) key id, and the secret pasted after an id', `id ${ASIA} and '${ASIA}|${AWS40}'`, "id [redacted] and '[redacted]'")
  leaves('a secret access key name with no key', 'aws_secret_access_key = ${AWS_SECRET} and AWS_SECRET_ACCESS_KEY=')
  takes('a GitLab token', `GITLAB ${fake('glpat-', 20)}`, 'GITLAB [redacted]')
  takes('a Hugging Face token', `HF ${fake('hf_', 34)}`, 'HF [redacted]')
  takes('an npm token', `NPM ${fake('npm_', 36)}`, 'NPM [redacted]')
  takes('a Stripe webhook secret', `WH ${fake('whsec_', 32)}`, 'WH [redacted]')
  leaves('their prefixes in code', 'glpat-short, hf_hub_download, npm_config_cache, whsec_...')
  takes('markdown’s escaped key names', `api\\_key=9f8e7d6c5b4a3210 client\\_secret=${fake('', 24)}`, 'api\\_key=[redacted] client\\_secret=[redacted]')
  takes('a client secret, by each name', `client_secret=${fake('', 24)} "clientSecret": "${fake('', 24)}" GOOGLE_CLIENT_SECRET=${fake('GOCSPX-', 28)}`, 'client_secret=[redacted] "clientSecret": "[redacted]" GOOGLE_CLIENT_SECRET=[redacted]')
  takes('a token, by each name', `access_token=${fake('ya29.', 40)} "refresh_token": "${fake('1//0g', 40)}" GITHUB_TOKEN=${fake('', 40, '0123456789abcdef')} refreshToken: '${fake('', 24)}'`, 'access_token=[redacted] "refresh_token": "[redacted]" GITHUB_TOKEN=[redacted] refreshToken: \'[redacted]\'')
  for (const code of [
    'client_secret: str',
    'clientSecret: process.env.GOOGLE_CLIENT_SECRET',
    'client_secret="YOUR_CLIENT_SECRET"',
    'token: string',
    'max_tokens: 4096',
    'eos_token: 2',
    'token = await getToken()',
    'token=${TOKEN}',
    'accessToken: "<your-access-token>"',
    'csrf_token: "{{ csrf_token() }}"'
  ]) {
    leaves(`code or a placeholder: ${code}`, code)
  }
}

section('redaction 3: cleaning cleaned text again changes nothing')
{
  // `recleanChat` cleans stored text in place, so every rule's output must be a fixed point.
  const samples = [
    'DB_PASSWORD=Xy7&kL9#mQ2vP and api_key=9f8e7d6c,5b4a3210ffee',
    '{ user: x, password: abc123xyz, b: 2 } and export PASSWORD=abc123; npm start',
    'https://x.io/cb?user=me&password=hunter22&next=/home and Server=db;Password=Xy7&kL9;Encrypt=true',
    `Authorization: Bearer ${fake('', 32)} and aws\\_secret\\_access\\_key=${fake('', 40, 'Ab3Cd5Ef7/Gh9Jk2+Mn4Pq6Rs8Tu')}`,
    `access_token=${fake('ya29.', 40)}, refreshToken: '${fake('', 24)}' (password=p4ss.Word.xyz)`
  ]
  const once = samples.map((s) => cleanText(s, { redact: true, maxBytes: Infinity }))
  check('a second clean is a fixed point', once.map((s) => cleanText(s, { redact: true, maxBytes: Infinity })), once)
}

section('redaction 3: no input makes a rule backtrack (64 KB, each under a second)')
{
  const K = 64 * 1024
  const fill = (unit: string): string => unit.repeat(Math.ceil(K / unit.length)).slice(0, K)
  // The first was 6.8 s under 2 (a trailing `[…]+$`), the next three 19–21 s under 3's first cut (an unbounded lookbehind retried per space).
  const worst: Record<string, string> = {
    'a value of closers that does not end the value': 'password=a' + fill(')') + 'x',
    'a separator of spaces before an unclosed quote': 'password=' + fill(' ') + '"',
    'spaces both sides of =': 'password' + fill(' ').slice(K / 2) + '=' + fill(' ').slice(K / 2) + '"',
    'a query key’s spaces': '?password=' + fill(' ') + '"',
    'a quote run inside a value': 'password=a' + fill("'b"),
    'an escaped newline run': 'password=a' + fill('\\n'),
    'a dotted path run': 'apiKey: ' + fill('a9b.'),
    'a query run': 'https://x/?' + fill('token=abcdefghijkl&'),
    'compact JSON': fill('"next_page_token":null},')
  }
  const slow: string[] = []
  for (const [name, text] of Object.entries(worst)) {
    const t0 = performance.now()
    cleanText(text, { redact: true })
    if (performance.now() - t0 > 1000) slow.push(name)
  }
  check('every worst case cleans in under a second', slow, [])
}

section('opening a hit')
{
  const ctx = { installed: new Set<CodingCliId>(['claude', 'codex']), resumable: resumableClis() }
  check('Codex and OpenCode can reopen one chat by id (read in their binaries)', [...resumableClis()].sort(), ['codex', 'opencode'])
  check('Claude resumes through the usual path', chatOpenAction({ source: 'claude', nativeId: 'abc', cwd: '/w', subagent: false }, ctx), {
    kind: 'claude',
    sessionId: 'abc',
    cwd: '/w'
  })
  const hitOf = (source: ChatOrigin, over: { nativeId?: string; cwd?: string | null; subagent?: boolean } = {}) => ({
    chatId: 7,
    source,
    nativeId: over.nativeId ?? 'x-1',
    cwd: over.cwd === undefined ? '/w' : over.cwd,
    subagent: over.subagent ?? false
  })
  check('Codex, installed, reopens in Codex', chatOpenAction(hitOf('codex'), ctx).kind, 'agent')
  const ocView = chatOpenAction(hitOf('opencode', { nativeId: 'ses_1' }), ctx)
  check('OpenCode, not installed, opens in the viewer and says why', [ocView.kind, ocView.kind === 'view' && ocView.chatId, ocView.kind === 'view' && ocView.note?.startsWith('OpenCode isn’t installed')], ['view', 7, true])
  check('Zed and Cowork open in the viewer', [chatOpenAction(hitOf('zed', { nativeId: 'z' }), ctx).kind, chatOpenAction(hitOf('claude-cowork', { nativeId: 'c' }), ctx).kind], ['view', 'view'])
  const subView = chatOpenAction(hitOf('claude', { nativeId: 'a/b', subagent: true }), ctx)
  check('a subagent transcript is never resumed: it opens in the viewer, which says what it is', [subView.kind, subView.kind === 'view' && subView.note?.includes('subagent')], ['view', true])
  check('a chat with no folder is viewed, not resumed', chatOpenAction(hitOf('claude', { cwd: null }), ctx).kind, 'view')
  check('an import always opens in the viewer, with no excuse to make', [chatOpenAction(hitOf('export-claude', { cwd: null }), ctx), chatOpenAction(hitOf('export-chatgpt'), ctx).kind], [
    { kind: 'view', chatId: 7, note: null },
    'view'
  ])
  const base = { endpoint: DEFAULT_ENDPOINT, openrouterKey: '', continueLast: true, mcp: [] }
  const codex = agentLaunchPlan({ ...base, id: 'codex', resumeId: '019f456c-d3fd-7e83-927d-f3b8ad5ac6cf' })
  check('codex reopens by id, and the id wins over continue', codex.ok ? codex.plan.args : codex, ['resume', '019f456c-d3fd-7e83-927d-f3b8ad5ac6cf'])
  const oc = agentLaunchPlan({ ...base, id: 'opencode', resumeId: 'ses_abc123' })
  check('opencode reopens with --session', oc.ok ? oc.plan.args : oc, ['--session', 'ses_abc123'])
  check('an id with a cmd.exe metacharacter is refused', agentLaunchPlan({ ...base, id: 'codex', resumeId: 'abc&calc' }).ok, false)
  check('a CLI with no by-id resume is refused, not started fresh', agentLaunchPlan({ ...base, id: 'gemini', resumeId: 'abcdef12' }).ok, false)
  check('isSafeResumeId', [isSafeResumeId('ses_abc123'), isSafeResumeId('a b'), isSafeResumeId('-x'), isSafeResumeId('x')], [true, false, false, false])
}

section('the viewer’s highlight follows the search’s rule')
{
  const marked = (text: string, q: string): string[] => highlightRanges(text, q).map(([s, e]) => text.slice(s, e))
  check('a word that STARTS with a query word is marked whole, any case', marked('Stoke sessions, STOKED, unstoked', 'stok'), ['Stoke', 'STOKED'])
  check('accents fold both ways', marked('tiếng Việt and naïve café', 'viet naive cafe'), ['Việt', 'naïve', 'café'])
  check('underscore is a separator, as in FTS5’s unicode61', marked('foo_bar baz', 'bar'), ['bar'])
  check('every query word is looked for', marked('the wombat met a quokka', 'quok womb'), ['wombat', 'quokka'])
  check('CJK runs are one word', marked('日本語 text', '日本'), ['日本語'])
  check('nothing to mark for an empty or wordless query', [highlightRanges('abc', ''), highlightRanges('abc', ' -- ')], [[], []])
}

section('import disclosure: every cap that binds is said')
{
  const rec = (over: Partial<ChatImportRecord>): ChatImportRecord => ({
    id: 1,
    kind: 'export-claude',
    fileName: 'x.zip',
    bytes: 1,
    importedMs: 0,
    found: 3,
    admitted: 3,
    added: 3,
    updated: 0,
    empty: 0,
    truncated: 0,
    cappedBy: null,
    indexed: 3,
    ...over
  })
  const caps = { ...CHAT_CAP_DEFAULTS, perSource: 2 }
  check('all of it', importDisclosure(rec({}), caps), 'Imported all 3 conversations.')
  check('per tool', importDisclosure(rec({ admitted: 2, added: 2, indexed: 2, cappedBy: 'perSource' }), caps), 'Imported the newest 2 of 3 conversations (the limit is 2 per tool).')
  check('the total', importDisclosure(rec({ admitted: 2, added: 2, indexed: 2, cappedBy: 'total' }), { ...caps, total: 2 }).startsWith('Imported the newest 2 of 3 conversations: the index holds at most 2 chats.'), true)
  check(
    'updated in place, empty, kept in part, and since left',
    importDisclosure(rec({ added: 1, updated: 1, empty: 1, truncated: 1, indexed: 1 }), caps),
    'Imported all 3 conversations. 1 was already here from an earlier import and was updated in place. 1 held no text and was left out. 1 is kept in part (over 512 KB of text). 1 has since left the index — a newer import of the same conversations, the per-tool or total limit, or the index’s size ceiling.'
  )
  check('an empty file says so', importDisclosure(rec({ found: 0, admitted: 0, added: 0, indexed: 0 }), caps), 'The file held no conversations.')
  check(
    'a stopped import says how far it got, never "all"',
    importDisclosure(rec({ found: 5, admitted: 5, added: 2, indexed: 2 }), { ...caps, perSource: 10 }),
    'The import was stopped after 2 of 5 conversations. Import the file again to finish: the ones already here are updated in place, not copied.'
  )
  check(
    '...and the cap it was under',
    importDisclosure(rec({ found: 5, admitted: 2, added: 1, indexed: 1, cappedBy: 'perSource' }), caps),
    'The import was stopped after 1 of the newest 2 of 5 conversations (the limit is 2 per tool). Import the file again to finish: the ones already here are updated in place, not copied.'
  )
  check(
    'a record not yet finished (running, or its worker killed) is not "all" either',
    importDisclosure(rec({ found: 5, admitted: 0, added: 0, indexed: 3 }), caps),
    'This import has not finished: 3 of the file’s 5 conversations are in the index.'
  )
}

section('disclosure: a cap that binds is said out loud')
{
  const s = (over: Partial<ChatSourceStatus>): ChatSourceStatus => ({ ...emptyChatStatus('/x').sources[0], ...over })
  const caps = { ...CHAT_CAP_DEFAULTS, perSource: 10 }
  check('per-source', sourceDisclosure(s({ found: 30, indexed: 10, cappedBy: 'perSource' }), caps), 'Indexed the newest 10 of 30 chats (the limit is 10 per tool).')
  check('still going', sourceDisclosure(s({ found: 30, indexed: 4, cappedBy: 'time' }), caps).startsWith('Still indexing: 4 of 30 so far.'), true)
  check('discovery', sourceDisclosure(s({ found: 50, foundAtLeast: true, indexed: 10, cappedBy: 'discovery' }), { ...caps, perSource: 100 }), 'Indexed 10 chats. Stopped counting at 50+ files.')
  check('all of it', sourceDisclosure(s({ found: 3, indexed: 3 }), caps), 'Indexed all 3 chats.')
  check('copies are named, and not counted as missing', sourceDisclosure(s({ found: 3, indexed: 2, duplicates: 1 }), caps), 'Indexed all 2 chats. 1 more is a copy of chats their own tool still has, so it is searched there, not twice.')
}

/* ------------------------------------------------------------- fixtures */

const root = mkdtempSync(join(tmpdir(), 'stoke-chat-sources-'))
const home = join(root, 'home')
const userData = join(root, 'userData')
const storeDir = join(userData, 'chat-index')
const env: SourceEnv = { home, env: {}, platform: process.platform }
const T0 = Date.parse('2026-09-01T00:00:00Z')

function write(path: string, text: string, mtimeMs?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

const jl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n'
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const iso = (ms: number): string => new Date(ms).toISOString()

const BLOB = 'Zm9vYmFyYmF6' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy'.repeat(8)

function claudeChat(i: number, cwd: string, extra = ''): string {
  const t = T0 + i * 60_000
  return jl([
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', message: { role: 'user', content: `hello chat${i} about topic${i} ${extra}` }, cwd, gitBranch: 'main', timestamp: iso(t), sessionId: uuid(i) },
    {
      type: 'assistant',
      timestamp: iso(t + 1000),
      message: {
        model: 'claude-opus-5',
        content: [
          { type: 'thinking', thinking: 'thinkword' },
          { type: 'text', text: `answer${i} alpha` },
          { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'toolinputword' } }
        ]
      }
    },
    { type: 'user', timestamp: iso(t + 2000), message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'tooloutputword' }] } },
    { type: 'user', isMeta: true, message: { content: 'metaword' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sidechainword' }] } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'ai-title', aiTitle: `Title number ${i}` }
  ])
}

/*
 * A subagent's own transcript, as the CLI writes it under `<session>/subagents/`:
 * EVERY record carries `isSidechain: true` (measured: 7,378 of 7,378 user and
 * assistant records across 52 real files, and none with an ai-title). A
 * fixture without the flag is how "subagents on" once indexed nothing and no
 * check saw it.
 */
function claudeSubagentChat(i: number, cwd: string, word: string): string {
  const t = T0 + i * 60_000
  return jl([
    { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: `subagent task ${word}` }, cwd, timestamp: iso(t), sessionId: uuid(29) },
    {
      type: 'assistant',
      isSidechain: true,
      agentId: 'a1',
      timestamp: iso(t + 1000),
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: `subagent report ${word}` }, { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: 'subtoolword' } }] }
    },
    { type: 'user', isSidechain: true, agentId: 'a1', cwd, timestamp: iso(t + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'subtooloutputword' }] } }
  ])
}

const projDir = join(home, '.claude', 'projects', '-tmp-proj-a')
const claudeFile = (i: number): string => join(projDir, `${uuid(i)}.jsonl`)
for (let i = 0; i < 30; i++) {
  const extra =
    i === 29
      ? `Größe tiếng Việt 日本語 naïve café ${BLOB} key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV end`
      : ''
  write(claudeFile(i), claudeChat(i, '/tmp/proj-a', extra), T0 + i * 60_000)
}
// A subagent's transcript beside its session, and a bystander that is not a transcript at all.
write(join(projDir, uuid(29), 'subagents', 'agent-a1.jsonl'), claudeSubagentChat(99, '/tmp/proj-a', 'subagentword'), T0 + 90 * 60_000)
write(join(projDir, 'notes.txt'), 'bystander, not a chat')

// Codex: the threads table, one user thread and one guardian subagent, and their rollouts.
const codexId = '019f456c-d3fd-7e83-927d-f3b8ad5ac6cf'
const guardId = '019f456c-aaaa-7e83-927d-f3b8ad5ac6cf'
const codexDir = join(home, '.codex', 'sessions', '2026', '09', '28')
const codexRollout = join(codexDir, `rollout-2026-09-28T16-02-23-${codexId}.jsonl`)
const guardRollout = join(codexDir, `rollout-2026-09-28T16-05-00-${guardId}.jsonl`)
const codexT = T0 + 40 * 60_000
write(
  codexRollout,
  jl([
    { timestamp: iso(codexT), type: 'session_meta', payload: { id: codexId, cwd: '/tmp/codex-proj', timestamp: iso(codexT), source: 'vscode' } },
    { timestamp: iso(codexT), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/tmp/codex-proj' } },
    { timestamp: iso(codexT), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developerword rules' }] } },
    {
      timestamp: iso(codexT + 1),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd> envcontextword\n</environment_context>' },
          { type: 'input_text', text: 'codex question about quokka' }
        ]
      }
    },
    { timestamp: iso(codexT + 2), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: 'codex question about quokka eventdupword' } } },
    { timestamp: iso(codexT + 3), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'reasoningword' }] } },
    { timestamp: iso(codexT + 4), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"functionargword"}' } },
    { timestamp: iso(codexT + 5), type: 'response_item', payload: { type: 'function_call_output', output: 'functionoutputword' } },
    { timestamp: iso(codexT + 6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex answer wombat' }] } }
  ]),
  codexT + 10_000
)
write(
  guardRollout,
  jl([
    { timestamp: iso(codexT), type: 'session_meta', payload: { id: guardId, cwd: '/tmp/codex-proj', source: { subagent: { other: 'guardian' } } } },
    { timestamp: iso(codexT), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'guardianword' }] } }
  ]),
  codexT + 20_000
)
{
  const db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'))
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT,
    first_user_message TEXT NOT NULL DEFAULT '', model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT)`)
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  // `title` as the desktop app often leaves it (its own context first); `name` is what Codex shows.
  ins.run(codexId, codexRollout, codexT / 1000, codexT / 1000, 'vscode', '/tmp/codex-proj', '# Files mentioned by the user: ctxtitleword', 0, 'main', 'codex question about quokka', 'gpt-6.1-sol', codexT, codexT + 10_000, 'Quokka thread name')
  ins.run(guardId, guardRollout, codexT / 1000, codexT / 1000, '{"subagent":{"other":"guardian"}}', '/tmp/codex-proj', '', 0, null, '', null, codexT, codexT + 20_000, null)
  db.close()
}

// OpenCode: one session, a text part each way, a tool part, a synthetic part, a reasoning part.
{
  const path = opencodeDbPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, parent_id TEXT, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`)
  const t = T0 + 35 * 60_000
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_abc123', 'OpenCode wallaby', '/tmp/oc', t, t + 5000, null, null)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_child1', 'child', '/tmp/oc', t, t + 6000, 'ses_abc123', null)
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
  msg.run('msg_1', 'ses_abc123', t, t, JSON.stringify({ role: 'user' }))
  msg.run('msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ role: 'assistant' }))
  msg.run('msg_c', 'ses_child1', t, t, JSON.stringify({ role: 'user' }))
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)')
  part.run('prt_1', 'msg_1', 'ses_abc123', t, t, JSON.stringify({ type: 'text', text: 'opencode question wallaby' }))
  part.run('prt_2', 'msg_1', 'ses_abc123', t, t, JSON.stringify({ type: 'text', text: 'syntheticword', synthetic: true }))
  part.run('prt_3', 'msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ type: 'reasoning', text: 'ocreasonword' }))
  part.run('prt_4', 'msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ type: 'tool', state: { output: 'opencodetoolword' } }))
  part.run('prt_5', 'msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ type: 'text', text: 'opencode answer bandicoot' }))
  part.run('prt_6', 'msg_c', 'ses_child1', t, t, JSON.stringify({ type: 'text', text: 'childsessionword' }))
  db.close()
}

// Cline: one imported copy of the Codex thread above, and one of its own.
const clineRootDir = join(home, '.cline', 'data', 'sessions')
function clineSession(id: string, meta: unknown, messages: unknown, mtime: number): void {
  write(join(clineRootDir, id, `${id}.json`), JSON.stringify(meta))
  write(join(clineRootDir, id, `${id}.messages.json`), JSON.stringify(messages), mtime)
}
clineSession(
  '1783576295230_COPY1',
  { session_id: '1783576295230_COPY1', cwd: '/tmp/codex-proj', prompt: 'codex question', started_at: iso(codexT), metadata: { title: 'Imported quokka', importedFrom: { tool: 'codex', sourceSessionId: codexId } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'clinecopyword codex question' }], ts: codexT }] },
  T0 + 41 * 60_000
)
clineSession(
  '1783576295230_OWN01',
  { session_id: '1783576295230_OWN01', cwd: '/tmp/cline-proj', prompt: 'koala', started_at: iso(T0), metadata: { title: 'Native cline koala' } },
  {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'native cline koala question <environment_details>envdetailsword</environment_details>' }], ts: T0 },
      { role: 'assistant', content: [{ type: 'text', text: 'cline answer dingo' }, { type: 'tool_use', name: 'x', input: { q: 'clinetoolword' } }], ts: T0 + 1 },
      { role: 'user', content: [{ type: 'tool_result', content: 'clineresultword' }], ts: T0 + 2 }
    ]
  },
  T0 + 36 * 60_000
)

// A copy of a Claude chat that Claude's own cap leaves OUT of range: still Claude's, never Cline's.
clineSession(
  '1783576295230_COPY2',
  { session_id: '1783576295230_COPY2', cwd: '/tmp/proj-a', started_at: iso(T0), metadata: { title: 'Imported old chat', importedFrom: { tool: 'claude-code', sourceSessionId: uuid(3) } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'clineoldcopyword' }], ts: T0 }] },
  T0 + 42 * 60_000
)
// A copy of the Codex guardian subagent thread, which Codex's own listing withholds while subagents are off.
clineSession(
  '1783576295230_COPY3',
  { session_id: '1783576295230_COPY3', cwd: '/tmp/codex-proj', started_at: iso(T0), metadata: { title: 'Imported guardian', importedFrom: { tool: 'codex', sourceSessionId: guardId } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'clineguardcopyword' }], ts: T0 }] },
  T0 + 43 * 60_000
)
// A copy whose original is gone from its tool: the last record of it, so it is kept.
clineSession(
  '1783576295230_ORPH1',
  { session_id: '1783576295230_ORPH1', cwd: '/tmp/codex-gone', started_at: iso(T0), metadata: { title: 'Orphaned copy', importedFrom: { tool: 'codex', sourceSessionId: '019f0000-0000-7000-8000-000000000000' } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'orphanedcopyword' }], ts: T0 }] },
  T0 + 34 * 60_000
)

// Zed: one thread, zstd-compressed JSON, as Zed stores it.
{
  const path = zedDbPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)')
  const doc = {
    title: 'Zed platypus',
    updated_at: iso(T0 + 37 * 60_000),
    model: { provider: 'x', model: 'zed-model' },
    subagent_context: null,
    messages: [
      { User: { id: 'u1', content: [{ Text: 'zed question platypus' }, { Mention: { uri: 'zedmentionword' } }] } },
      { Agent: { content: [{ Thinking: { text: 'zedthinkword' } }, { Text: 'zed answer echidna' }, { ToolUse: { name: 'x', input: 'zedtoolword' } }], tool_results: {} } }
    ]
  }
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)').run('zed-thread-1', 'Zed platypus', doc.updated_at, 'zstd', zstdCompressSync(Buffer.from(JSON.stringify(doc))), null, '/tmp/zed-proj', null, doc.updated_at)
  db.close()
}

// Claude desktop Cowork: metadata that carries an account name and email, and its nested transcript.
{
  const base = join(coworkRoot(env), 'org-1', 'acct-1')
  write(
    join(base, 'local_s1.json'),
    JSON.stringify({ title: 'Cowork numbat', cwd: '/tmp/cowork', createdAt: iso(T0), lastActivityAt: iso(T0 + 38 * 60_000), emailAddress: 'person@example.com', accountName: 'Secretive Person', isArchived: false })
  )
  write(join(base, 'local_s1', '.claude', 'projects', '-enc', `${uuid(500)}.jsonl`), claudeChat(500, '/outputs', 'cowork question numbat'), T0 + 38 * 60_000)
}

const STORE_MODE_CHECKABLE = process.platform !== 'win32'
const options = (over: Partial<ChatIndexOptions> = {}, caps: Partial<ChatIndexOptions['caps']> = {}): ChatIndexOptions => ({
  ...CHAT_INDEX_DEFAULTS,
  ...over,
  sources: { ...CHAT_INDEX_DEFAULTS.sources, ...(over.sources ?? {}) },
  caps: { ...CHAT_INDEX_DEFAULTS.caps, perSource: 10, ...caps }
})
let clock = Date.now()
const hooks = (over: Partial<PassHooks> = {}): PassHooks => ({
  now: () => clock,
  yieldTurn: async () => undefined,
  cancelled: () => false,
  progress: () => undefined,
  ...over
})
const words = (store: ChatStore, q: string): string[] => store.search(q).map((h) => `${h.source}:${h.nativeId}`)

/* ------------------------------------------------------- export fixtures */

/*
 * A zip writer, just enough to build real archives here rather than trust a
 * fixture on disk: stored and deflated members, ZIP64 when asked (some writers
 * use it for every archive), and the knobs a hostile archive turns — a size
 * header that lies, a flag, a method, a wrong checksum.
 */
interface ZipMember {
  name: string
  data: Buffer
  method?: 0 | 8
  /** The size the headers claim, when it is not the truth. */
  declaredSize?: number
  flags?: number
  /** A method number other than 0/8, written as is. */
  rawMethod?: number
  badCrc?: boolean
}
function makeZip(members: ZipMember[], zip64 = false): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const m of members) {
    const method = m.method ?? 8
    const packed = method === 8 ? deflateRawSync(m.data) : m.data
    const size = m.declaredSize ?? m.data.length
    const crc = m.badCrc ? (crc32(m.data) ^ 1) >>> 0 : crc32(m.data)
    const name = Buffer.from(m.name, 'utf8')
    const flags = (m.flags ?? 0) | 0x800
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(zip64 ? 45 : 20, 4)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(m.rawMethod ?? method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 18)
    lh.writeUInt32LE(zip64 ? 0xffffffff : size, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, packed)
    const extra = zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0)
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(size), 4)
      extra.writeBigUInt64LE(BigInt(packed.length), 12)
      extra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(zip64 ? 45 : 20, 4)
    ch.writeUInt16LE(zip64 ? 45 : 20, 6)
    ch.writeUInt16LE(flags, 8)
    ch.writeUInt16LE(m.rawMethod ?? method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20)
    ch.writeUInt32LE(zip64 ? 0xffffffff : size, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(extra.length, 30)
    ch.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    centrals.push(ch, name, extra)
    offset += 30 + name.length + packed.length
  }
  const dir = Buffer.concat(centrals)
  const tail: Buffer[] = []
  if (zip64) {
    const rec = Buffer.alloc(56)
    rec.writeUInt32LE(0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    rec.writeUInt16LE(45, 12)
    rec.writeUInt16LE(45, 14)
    rec.writeBigUInt64LE(BigInt(members.length), 24)
    rec.writeBigUInt64LE(BigInt(members.length), 32)
    rec.writeBigUInt64LE(BigInt(dir.length), 40)
    rec.writeBigUInt64LE(BigInt(offset), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(offset + dir.length), 8)
    loc.writeUInt32LE(1, 16)
    tail.push(rec, loc)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip64 ? 0xffff : members.length, 8)
  end.writeUInt16LE(zip64 ? 0xffff : members.length, 10)
  end.writeUInt32LE(zip64 ? 0xffffffff : dir.length, 12)
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  return Buffer.concat([...locals, dir, ...tail, end])
}

const H = 3_600_000
/** A claude.ai export: a branched conversation, a legacy text-only one, and an empty one. */
function claudeAiExport(over: { title?: string; extra?: string } = {}): unknown[] {
  const root = '00000000-0000-4000-8000-000000000000'
  const m = (uuid: string, sender: string, parent: string, blocks: unknown[], t: number, rest: Record<string, unknown> = {}) => ({
    uuid,
    sender,
    parent_message_uuid: parent,
    created_at: iso(T0 + t),
    updated_at: iso(T0 + t),
    content: blocks,
    text: 'This block is not supported on your current device yet. claudeaiplaceholderword',
    attachments: [],
    files: [],
    ...rest
  })
  const text = (t: string) => ({ type: 'text', text: t, citations: [] })
  return [
    {
      uuid: 'ca-1',
      name: over.title ?? 'Echidna planning',
      summary: '',
      created_at: iso(T0 + 1 * H),
      updated_at: iso(T0 + 3 * H),
      account: { uuid: 'acct' },
      chat_messages: [
        m('m1', 'human', root, [text('How do echidnas lay eggs? claudeaiuserword')], 1 * H, {
          attachments: [{ file_name: 'burrow-notes.txt', file_size: 10, extracted_content: 'attachmentcontentword' }]
        }),
        m('m2', 'assistant', 'm1', [{ type: 'thinking', thinking: 'claudeaithinkword' }, text('Monotremes claudeaiassistantword'), { type: 'tool_use', name: 'web_search', input: { query: 'claudeaitoolword' } }, { type: 'tool_result', content: [{ type: 'text', text: 'claudeaitoolresultword' }] }], 1 * H + 1000),
        m('m3b', 'human', 'm2', [text(`currentbranchword ${over.extra ?? ''}`)], 2 * H + 5000),
        m('m4b', 'assistant', 'm3b', [text('currentreplyword key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV')], 2 * H + 6000),
        // An edit made LATER and last in the list, then switched away from: only the leaf pointer says which branch is shown.
        m('m3a', 'human', 'm2', [text('abandonedbranchword')], 2 * H + 7000),
        m('m4a', 'assistant', 'm3a', [text('abandonedreplyword')], 2 * H + 8000)
      ],
      current_leaf_message_uuid: 'm4b'
    },
    {
      uuid: 'ca-2',
      name: 'Legacy flat chat',
      created_at: iso(T0 + 0.5 * H),
      updated_at: iso(T0 + 0.6 * H),
      chat_messages: [
        { uuid: 'x1', sender: 'human', text: 'flatlegacyword question', content: [], created_at: iso(T0 + 0.5 * H) },
        { uuid: 'x2', sender: 'assistant', text: 'flatlegacyreply', created_at: iso(T0 + 0.55 * H) }
      ]
    },
    { uuid: 'ca-3', name: '', created_at: iso(T0 + 4 * H), updated_at: iso(T0 + 4 * H), chat_messages: [] }
  ]
}

/** A ChatGPT export: a mapping tree with an edited turn (two branches), tool calls, hidden and system nodes. */
function chatgptExport(): unknown[] {
  const s = (h: number): number => (T0 + h * H) / 1000
  const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message })
  const msg = (role: string, parts: unknown[], t: number | null, rest: Record<string, unknown> = {}) => ({
    id: `msg-${Math.random()}`,
    author: { role, name: null, metadata: {} },
    create_time: t,
    content: { content_type: 'text', parts },
    status: 'finished_successfully',
    recipient: 'all',
    metadata: {},
    ...rest
  })
  return [
    {
      title: 'Wombat facts',
      create_time: s(5),
      update_time: s(6),
      conversation_id: 'cg-1',
      id: 'cg-1',
      current_node: 'a2b',
      default_model_slug: 'gpt-4o',
      mapping: {
        root: node('root', null, ['sys'], null),
        sys: node('sys', 'root', ['ctx'], msg('system', ['chatgptsystemword'], null, { metadata: { is_visually_hidden_from_conversation: true } })),
        ctx: node('ctx', 'sys', ['u1'], msg('user', [], null, { content: { content_type: 'user_editable_context', user_profile: 'chatgptprofileword' }, metadata: { is_visually_hidden_from_conversation: true } })),
        u1: node('u1', 'ctx', ['a1'], msg('user', ['Tell me about wombats chatgptuserword'], s(5))),
        a1: node('a1', 'u1', ['u2a', 'u2b'], msg('assistant', ['Wombats dig chatgptreplyword'], s(5.01), { metadata: { model_slug: 'gpt-4o' } })),
        u2a: node('u2a', 'a1', ['a2a'], msg('user', ['oldbranchword'], s(5.1))),
        // Regenerated LATER than the branch shown: the user switched back, so only current_node tells them apart.
        a2a: node('a2a', 'u2a', [], msg('assistant', ['oldbranchreplyword'], s(5.9))),
        u2b: node('u2b', 'a1', ['t1'], msg('user', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://imageblobword' }, 'newbranchword with a picture'], s(5.2), { content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://imageblobword' }, 'newbranchword with a picture'] } })),
        t1: node('t1', 'u2b', ['tool1'], msg('assistant', [], s(5.21), { recipient: 'python', content: { content_type: 'code', language: 'python', text: 'chatgptcodeword' } })),
        tool1: node('tool1', 't1', ['a2b'], msg('tool', ['chatgpttooloutputword'], s(5.22))),
        a2b: node('a2b', 'tool1', [], msg('assistant', ['newbranchreplyword'], s(5.3), { metadata: { model_slug: 'gpt-5' } }))
      }
    },
    {
      // No current_node: the newest leaf is the conversation.
      title: 'Leafless',
      create_time: s(1),
      update_time: s(1.5),
      id: 'cg-2',
      mapping: {
        r: node('r', null, ['q'], null),
        q: node('q', 'r', ['x', 'y'], msg('user', ['leaflessquestion'], s(1))),
        x: node('x', 'q', [], msg('assistant', ['olderleafword'], s(1.1))),
        y: node('y', 'q', [], msg('assistant', ['newerleafword'], s(1.2)))
      }
    }
  ]
}

const exportsDir = join(root, 'exports')
mkdirSync(exportsDir, { recursive: true })
const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), 'utf8')
const claudeZip = join(exportsDir, 'data-2026-09-30-claude.zip')
writeFileSync(
  claudeZip,
  makeZip([
    { name: 'users.json', data: json([{ uuid: 'u', full_name: 'Private Person', email_address: 'person@example.com' }]) },
    { name: 'conversations.json', data: json(claudeAiExport()) },
    { name: 'projects.json', data: json([]), method: 0 }
  ])
)
const chatgptZip = join(exportsDir, 'chatgpt-export.zip')
writeFileSync(
  chatgptZip,
  makeZip(
    [
      { name: 'chat.html', data: Buffer.from('<html>chathtmlword</html>'), method: 0 },
      { name: 'user.json', data: json({ email: 'person@example.com' }) },
      // An image the importer must never inflate: a random blob that is not even deflate.
      { name: 'file-abc/image.png', data: Buffer.from(Array.from({ length: 4096 }, (_, k) => (k * 7919) % 251)), method: 0 },
      { name: 'conversations.json', data: json(chatgptExport()) }
    ],
    true
  )
)
const importHooks = (over: Partial<ImportHooks> = {}): ImportHooks => ({ now: () => clock, yieldTurn: async () => undefined, cancelled: () => false, ...over })
const BIG_TEXT = 512 * 1024 * 1024

try {
  section('roots honour each tool’s own override')
  check('CLAUDE_CONFIG_DIR is read, before ~/.claude', claudeRoots({ ...env, env: { CLAUDE_CONFIG_DIR: '/alt' } })[0], join('/alt', 'projects'))
  check('CODEX_HOME moves Codex', codexHome({ ...env, env: { CODEX_HOME: '/cx' } }), '/cx')

  section('detection: names and sizes only, before any yes')
  const det = ['claude', 'codex', 'opencode', 'claude-cowork', 'zed', 'cline'].map((id) => detectSource(id as never, env, false, discovery(Date.now())))
  check('Claude: the 30 top-level transcripts, never the subagent', det[0].chats, 30)
  check('Codex: both rollouts by name (the table is not opened)', det[1].chats, 2)
  check('OpenCode and Zed: a size, no count (a database is not opened)', [det[2].chats, det[4].chats, det[2].bytes > 0, det[4].bytes > 0], [null, null, true, true])
  check('Cowork and Cline counted by name', [det[3].chats, det[5].chats], [1, 5])
  check('detection created no store', existsSync(storeDir), false)
  const found = offerFound({ sources: det, at: 0 })
  check('the offer names what was found', found.text.startsWith('Claude Code (30), Codex (2), OpenCode ('), true)

  section('first pass: newest first, capped, disclosed')
  const store = ChatStore.open(storeDir)
  const pass1 = await runPass(store, { env, options: options() }, hooks())
  const st1 = store.status('idle')
  const claudeSt = st1.sources.find((s) => s.id === 'claude')!
  check('Claude: the newest 10 of 30 are indexed', [claudeSt.found, claudeSt.indexed, claudeSt.cappedBy], [30, 10, 'perSource'])
  check('...and it is said', sourceDisclosure(claudeSt, options().caps), 'Indexed the newest 10 of 30 chats (the limit is 10 per tool).')
  const kept = store.chatsOf('claude').map((c) => c.nativeId).sort()
  check('...the NEWEST ten', kept, Array.from({ length: 10 }, (_, k) => uuid(20 + k)).sort())
  check('Codex: the user thread only (the guardian subagent is left out)', store.chatsOf('codex').map((c) => c.nativeId), [codexId])
  check('OpenCode: the session, not its child', store.chatsOf('opencode').map((c) => c.nativeId), ['ses_abc123'])
  check('Zed and Cowork indexed', [store.count('zed'), store.count('claude-cowork')], [1, 1])
  const clineSt = st1.sources.find((s) => s.id === 'cline')!
  check(
    'Cline: copies of chats their tool still has are folded — in range or not — its own session and an orphaned copy kept',
    [store.chatsOf('cline').map((c) => c.nativeId).sort(), clineSt.duplicates],
    [['1783576295230_ORPH1', '1783576295230_OWN01'], 3]
  )
  check('...and that is said', sourceDisclosure(clineSt, options().caps), 'Indexed all 2 chats. 3 more are copies of chats their own tool still has, so they are searched there, not twice.')
  check('...an out-of-range original is not smuggled in through its copy', [words(store, 'clineoldcopyword'), words(store, 'orphanedcopyword')], [[], ['cline:1783576295230_ORPH1']])
  check('...nor a subagent thread, while subagents are off', words(store, 'clineguardcopyword'), [])
  check('the pass read files and stopped at no pass cap', [pass1.filesRead > 0, pass1.stoppedBy], [true, null])
  if (STORE_MODE_CHECKABLE) {
    const mode = (p: string): string => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : 'absent')
    check('store dir 0700; database, WAL and shm 0600', [mode(storeDir), mode(join(storeDir, 'index.sqlite')), mode(join(storeDir, 'index.sqlite-wal')), mode(join(storeDir, 'index.sqlite-shm'))], [
      '700',
      '600',
      '600',
      '600'
    ])
  } else console.log('  NOTE  file modes are not POSIX on Windows; the 0600 check runs on macOS and Linux')

  section('search: user and assistant words only')
  check('a user word', words(store, 'topic29'), [`claude:${uuid(29)}`])
  check('an assistant word', words(store, 'answer25'), [`claude:${uuid(25)}`])
  check('a title: Codex’s thread NAME, not its context-prefixed title', [words(store, 'Quokka thread'), words(store, 'ctxtitleword')], [[`codex:${codexId}`], []])
  for (const w of ['toolinputword', 'tooloutputword', 'thinkword', 'metaword', 'sidechainword', 'subagentword', 'developerword', 'envcontextword', 'eventdupword', 'reasoningword', 'functionargword', 'functionoutputword', 'guardianword', 'syntheticword', 'ocreasonword', 'opencodetoolword', 'childsessionword', 'envdetailsword', 'clinetoolword', 'clineresultword', 'clinecopyword', 'zedthinkword', 'zedtoolword', 'zedmentionword']) {
    check(`never indexed: ${w}`, words(store, w), [])
  }
  check('the account fields in Cowork’s metadata are never indexed', [words(store, 'example.com'), words(store, 'Secretive')], [[], []])
  check('a base64 blob is not searchable', words(store, 'Zm9vYmFyYmF6'), [])
  check('an API key is not searchable', words(store, 'ABCDEFGHIJKLMNOPQRSTUV'), [])
  check('...its place is marked', words(store, 'redacted'), [`claude:${uuid(29)}`])
  check('every source answers', ['wombat', 'bandicoot', 'echidna', 'numbat', 'dingo'].map((w) => words(store, w)[0]?.split(':')[0]), ['codex', 'opencode', 'zed', 'claude-cowork', 'cline'])
  const viet = store.search('Viet tieng')
  check('diacritics fold: "Viet tieng" finds "tiếng Việt"', viet.map((h) => h.nativeId), [uuid(29)])
  const sn = viet[0]?.snippet
  check('...and the snippet highlights the words as written', sn ? sn.ranges.map(([s, e]) => sn.text.slice(s, e)).sort() : null, ['Việt', 'tiếng'])
  check('a CJK word standing alone', words(store, '日本語'), [`claude:${uuid(29)}`])
  check('Größe', words(store, 'größe'), [`claude:${uuid(29)}`])
  // Every hit's snippet is its OWN chat's text (gotcha 125: a REAL-bound rowid gave all of them the first one's).
  const alpha = store.search('alpha')
  check(
    'each hit quotes its own chat',
    [alpha.length >= 5, alpha.every((h) => h.snippet.text.includes(`answer${Number(h.nativeId.slice(-12))} alpha`))],
    [true, true]
  )
  const codexHit = store.search('wombat')[0]
  check('a hit carries what opening needs', [codexHit.cwd, codexHit.title, codexHit.role, codexHit.subagent], ['/tmp/codex-proj', 'Quokka thread name', 'assistant', false])

  {
    // One conversation that says a word hundreds of times must not crowd out the others.
    const crowd = ChatStore.open(join(root, 'crowd-index'))
    const meta = { title: null, firstPrompt: null, cwd: '/w', gitBranch: null, model: null, createdMs: T0, updatedMs: T0 }
    const loud = crowd.upsertChat('claude', 'loud', meta, { subagent: false, dedupeKey: null, whole: true, redact: true })
    crowd.appendMessages(loud, Array.from({ length: 600 }, (_, k) => ({ role: 'assistant' as const, text: `crowdword crowdword again ${k}`, atMs: T0 })))
    const quiet = crowd.upsertChat('codex', 'quiet', meta, { subagent: false, dedupeKey: null, whole: true, redact: true })
    crowd.appendMessages(quiet, [{ role: 'user', text: 'one crowdword here', atMs: T0 }])
    check('one hit per chat, and a loud chat cannot crowd a quiet one out', crowd.search('crowdword').map((h) => h.nativeId).sort(), ['loud', 'quiet'])
    crowd.close()
  }

  section('subagents on: a subagent’s own transcript is its text')
  {
    const sub = ChatStore.open(join(root, 'sub-index'))
    await runPass(sub, { env, options: options({ subagents: true }) }, hooks())
    const subId = `${uuid(29)}/agent-a1`
    const hit = sub.search('subagentword')
    check('its words are searchable (every record in it is a sidechain one)', hit.map((h) => `${h.source}:${h.nativeId}`), [`claude:${subId}`])
    check('...as a subagent chat, both turns, its tool payloads left out', [hit[0]?.subagent, sub.messages(sub.chatId('claude', subId) ?? -1).length, words(sub, 'subtoolword'), words(sub, 'subtooloutputword')], [
      true,
      2,
      [],
      []
    ])
    check('a sidechain record inside a top-level transcript is still not the user’s thread', words(sub, 'sidechainword'), [])
    check(
      'no chat is stored with nothing to search',
      sub.chatsOf('claude').filter((c) => sub.messages(c.id).length === 0).length,
      0
    )
    sub.close()
  }

  section('a transcript with nothing to search is never a chat, and takes no slot')
  {
    // Newest first: an empty session (opened, /clear, closed), then two real ones, under a per-tool cap of 2.
    const eHome = join(root, 'empty-home')
    const eEnv: SourceEnv = { home: eHome, env: {}, platform: process.platform }
    const eDir = join(eHome, '.claude', 'projects', '-tmp-empty-proj')
    const eFile = (n: number): string => join(eDir, `${uuid(n)}.jsonl`)
    write(
      eFile(1),
      jl([
        { type: 'permission-mode', permissionMode: 'default' },
        { type: 'user', isMeta: true, cwd: '/tmp/empty-proj', message: { content: 'metaword' }, timestamp: iso(T0) },
        { type: 'user', cwd: '/tmp/empty-proj', message: { content: '<command-name>/clear</command-name>' }, timestamp: iso(T0) }
      ]),
      T0 + 30 * 60_000
    )
    // A session that `cd`s: its folder is the one it started in, which is where it resumes from.
    write(
      eFile(2),
      jl([
        { type: 'user', cwd: '/tmp/empty-proj', message: { content: 'started here gerbilword' }, timestamp: iso(T0 + 1000) },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: iso(T0 + 2000) },
        { type: 'user', cwd: '/tmp/empty-proj/moved', message: { content: 'then moved' }, timestamp: iso(T0 + 3000) }
      ]),
      T0 + 20 * 60_000
    )
    write(eFile(3), claudeChat(3, '/tmp/empty-proj', 'hamsterword'), T0 + 10 * 60_000)
    const e = ChatStore.open(join(root, 'empty-index'))
    const eOpts = options({}, { perSource: 2 })
    await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('the empty transcript is read but never stored as a chat', [e.hasChat('claude', uuid(1)), e.hasChat('claude', uuid(2))], [false, true])
    check('a whole read keeps the FIRST cwd, not the one a cd left', e.search('gerbilword')[0]?.cwd, '/tmp/empty-proj')
    await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('...and on the next pass its slot goes to the next-newest real chat', e.chatsOf('claude').map((c) => c.nativeId).sort(), [uuid(2), uuid(3)])
    const still = await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('...and then nothing is read again', [still.filesRead, still.bytesRead], [0, 0])
    appendFileSync(eFile(1), jl([{ type: 'user', cwd: '/tmp/empty-proj', message: { content: 'now a real question jerboaword' }, timestamp: iso(T0 + 5000) }]))
    utimesSync(eFile(1), (T0 + 31 * 60_000) / 1000, (T0 + 31 * 60_000) / 1000)
    await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('once it says something it is a chat again, newest, and the oldest makes room', [words(e, 'jerboaword'), e.chatsOf('claude').map((c) => c.nativeId).sort()], [
      [`claude:${uuid(1)}`],
      [uuid(1), uuid(2)]
    ])
    e.close()
  }

  section('the store ceiling: what it evicts stays out until it changes')
  {
    // Twelve chats of ~30 KB of text each; the ceiling is set to 70% of their text.
    const cHome = join(root, 'ceiling-home')
    const cEnv: SourceEnv = { home: cHome, env: {}, platform: process.platform }
    const cDir = join(cHome, '.claude', 'projects', '-tmp-ceiling')
    const cFile = (n: number): string => join(cDir, `${uuid(n)}.jsonl`)
    for (let n = 0; n < 12; n++) {
      const para = (k: number): string => Array.from({ length: 400 }, (_, w) => `ceil${n}w${k}x${w}`).join(' ')
      const recs: unknown[] = []
      for (let k = 0; k < 3; k++) {
        recs.push({ type: 'user', cwd: '/tmp/ceiling', message: { content: `question ${k} ${para(k)}` }, timestamp: iso(T0 + n * 60_000 + k) })
        recs.push({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${k} ${para(k + 10)}` }] }, timestamp: iso(T0 + n * 60_000 + k) })
      }
      write(cFile(n), jl(recs), T0 + n * 60_000)
    }
    const cOpts = options({}, { perSource: 50 })
    const full = ChatStore.open(join(root, 'ceiling-probe'))
    await runPass(full, { env: cEnv, options: cOpts }, hooks())
    const fullText = full.textBytes()
    full.close()
    const max = Math.floor(fullText * 0.7)
    const c = ChatStore.open(join(root, 'ceiling-index'))
    await runPass(c, { env: cEnv, options: cOpts, maxTextBytes: max }, hooks())
    const kept = c.chatsOf('claude').map((r) => r.nativeId).sort()
    const k = kept.length
    const cSt = (): ChatSourceStatus => c.status('idle').sources.find((s) => s.id === 'claude')!
    check(`the ceiling evicts, oldest first, and says so (kept ${k} of 12)`, [k, c.textBytes() <= max, kept, cSt().cappedBy], [
      8,
      true,
      Array.from({ length: k }, (_, j) => uuid(12 - k + j)).sort(),
      'store'
    ])
    const again = await runPass(c, { env: cEnv, options: cOpts, maxTextBytes: max }, hooks())
    check('the next pass reads nothing: the evicted are not admitted, read and evicted again', [again.filesRead, again.bytesRead, c.count('claude')], [0, 0, k])
    check('...and the status still names the ceiling', [cSt().cappedBy, sourceDisclosure(cSt(), cOpts.caps).includes('size ceiling (512 MB of chat text')], ['store', true])
    // The oldest evicted chat gets new activity: it is the newest now, so it comes back and an older one goes.
    appendFileSync(cFile(0), jl([{ type: 'user', cwd: '/tmp/ceiling', message: { content: 'back again capybaraword' }, timestamp: iso(T0 + 99 * 60_000) }]))
    utimesSync(cFile(0), (T0 + 99 * 60_000) / 1000, (T0 + 99 * 60_000) / 1000)
    const back = await runPass(c, { env: cEnv, options: cOpts, maxTextBytes: max }, hooks())
    check('a changed evicted chat is read once and kept, under the ceiling', [back.filesRead, words(c, 'capybaraword'), c.textBytes() <= max, c.count('claude')], [1, [`claude:${uuid(0)}`], true, k])
    const settled = await runPass(c, { env: cEnv, options: cOpts, maxTextBytes: max }, hooks())
    check('...and the pass after reads nothing again', [settled.filesRead, settled.bytesRead], [0, 0])
    // Changing what is asked for starts over once — a user's act, never every pass.
    const newOpts = options({}, { perSource: 49 })
    await runPass(c, { env: cEnv, options: newOpts, maxTextBytes: max }, hooks())
    const afterChange = await runPass(c, { env: cEnv, options: newOpts, maxTextBytes: max }, hooks())
    check('after an options change the ceiling settles again in one pass', [afterChange.filesRead, c.textBytes() <= max, c.count('claude'), cSt().cappedBy], [0, true, k, 'store'])
    c.close()
  }

  section('incremental: only appended bytes are read')
  const pass2 = await runPass(store, { env, options: options() }, hooks())
  check('an unchanged pass reads nothing', [pass2.bytesRead, pass2.filesRead], [0, 0])
  const target = claudeFile(27)
  const beforeMsgs = store.messages(store.chatId('claude', uuid(27))!).length
  // The appended turn ran after a `cd`: the chat's folder must stay the one it started in.
  const addition = jl([
    { type: 'user', message: { content: 'appended question platypusfish' }, cwd: '/tmp/proj-a/moved', timestamp: iso(T0 + 27 * 60_000 + 5000) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'appended answer' }] }, timestamp: iso(T0 + 27 * 60_000 + 6000) }
  ])
  appendFileSync(target, addition)
  utimesSync(target, (T0 + 27 * 60_000 + 7000) / 1000, (T0 + 27 * 60_000 + 7000) / 1000)
  const pass3 = await runPass(store, { env, options: options() }, hooks())
  check('the append costs its own bytes plus the one-byte newline check', pass3.bytesRead, Buffer.byteLength(addition) + 1)
  check('...folds exactly two new messages, no duplicates', store.messages(store.chatId('claude', uuid(27))!).length - beforeMsgs, 2)
  check('...and they are searchable', words(store, 'platypusfish'), [`claude:${uuid(27)}`])
  check('...and an append never moves the chat’s folder (the first cwd is where it resumes)', store.search('platypusfish')[0]?.cwd, '/tmp/proj-a')
  // A partial last line is not folded until its newline arrives, and then once.
  appendFileSync(target, JSON.stringify({ type: 'user', message: { content: 'halfline kiwiword' }, timestamp: iso(T0) }))
  await runPass(store, { env, options: options() }, hooks())
  check('a line with no newline yet is not read', words(store, 'kiwiword'), [])
  appendFileSync(target, '\n')
  await runPass(store, { env, options: options() }, hooks())
  check('...and is read once it is complete', [words(store, 'kiwiword'), store.search('kiwiword').length], [[`claude:${uuid(27)}`], 1])
  const afterKiwi = store.messages(store.chatId('claude', uuid(27))!).length
  // Rewritten in place under a new inode: read again from byte 0, not appended to.
  const tmp = `${target}.new`
  write(tmp, claudeChat(27, '/tmp/proj-a', 'rewrittenword'), T0 + 27 * 60_000 + 9000)
  renameSync(tmp, target)
  await runPass(store, { env, options: options() }, hooks())
  const rewritten = store.messages(store.chatId('claude', uuid(27))!)
  check('a replaced file is read whole: the old words go, the new come', [words(store, 'platypusfish'), words(store, 'rewrittenword').length, rewritten.length < afterKiwi], [[], 1, true])

  section('pruning, source switches, and the bystanders')
  unlinkSync(claudeFile(25))
  await runPass(store, { env, options: options() }, hooks())
  check('a transcript deleted at the source leaves the index', store.hasChat('claude', uuid(25)), false)
  check('...and the next-newest moves into range', store.hasChat('claude', uuid(19)), true)
  check('the bystander in the transcripts folder is untouched', readFileSync(join(projDir, 'notes.txt'), 'utf8'), 'bystander, not a chat')
  await runPass(store, { env, options: options({ sources: { ...CHAT_INDEX_DEFAULTS.sources, zed: false } }) }, hooks())
  check('a source switched off is dropped from the store', store.count('zed'), 0)
  await runPass(store, { env, options: options() }, hooks())
  check('...and comes back when switched on', store.count('zed'), 1)

  section('the pass caps: total, time, bytes, file size, text size, discovery')
  await runPass(store, { env, options: options({}, { total: 12 }) }, hooks())
  const stTotal = store.status('idle')
  check('total: the newest 12 across every source (a folded copy takes no slot)', store.count(), 12)
  const cutClaude = stTotal.sources.find((s) => s.id === 'claude')!
  check('...and the source it cut says the total is why', [cutClaude.cappedBy, sourceDisclosure(cutClaude, options({}, { total: 12 }).caps).includes('12-chat limit')], ['total', true])
  await runPass(store, { env, options: options() }, hooks())
  check('...lifting it brings them back', store.count() > 12, true)

  const timeStore = ChatStore.open(join(root, 'time-index'))
  // Every read of the clock moves it 2 s: the listing takes a few, then each chat one.
  let t = 0
  const timed = await runPass(timeStore, { env, options: options({}, { passSeconds: 10 }) }, hooks({ now: () => (t += 2_000) }))
  const timedClaude = timeStore.status('idle').sources.find((s) => s.id === 'claude')!
  check('time: a pass stops at its wall-time cap, and says which', [timed.stoppedBy, timedClaude.cappedBy], ['time', 'time'])
  check('...having read part of the range', timedClaude.indexed > 0 && timedClaude.indexed < 10, true)
  check(
    '...and the source says it is still going, against its target',
    sourceDisclosure(timedClaude, options({}, { passSeconds: 10 }).caps).startsWith(`Still indexing: ${timedClaude.indexed} of 10 so far (the newest 10 of ${timedClaude.found}).`),
    true
  )
  const resumed = await runPass(timeStore, { env, options: options() }, hooks())
  check('...and the next pass carries on to the full range', [resumed.stoppedBy, timeStore.count('claude')], [null, 10])
  timeStore.close()

  const byteStore = ChatStore.open(join(root, 'byte-index'))
  const bytePass = await runPass(byteStore, { env, options: options({}, { passMb: 0.001 }) }, hooks())
  check('bytes: a pass stops at its byte cap', [bytePass.stoppedBy, byteStore.count() < 10], ['bytes', true])
  byteStore.close()

  const bigStore = ChatStore.open(join(root, 'big-index'))
  // Just under chat 29's size (the one with the long pasted line): it is over the cap, the rest are not.
  const fileMb = (statSync(claudeFile(29)).size - 100) / (1024 * 1024)
  check('(fixture: every other chat in range is under that cap)', Array.from({ length: 9 }, (_, k) => 20 + k).filter((i) => i !== 25).every((i) => statSync(claudeFile(i)).size < statSync(claudeFile(29)).size - 100), true)
  await runPass(bigStore, { env, options: options({}, { fileMb }) }, hooks())
  const bigSt = bigStore.status('idle').sources.find((s) => s.id === 'claude')!
  const bigId = bigStore.chatId('claude', uuid(29))
  check('file size: a transcript over the cap is read as a head and a tail, and flagged', [bigSt.truncated, bigId !== null && bigStore.messages(bigId).length > 0], [1, true])
  check('...and it is said', sourceDisclosure(bigSt, options({}, { fileMb }).caps).includes('1 is kept in part'), true)
  bigStore.close()

  setDiscoveryLimitForTest(5)
  const discStore = ChatStore.open(join(root, 'disc-index'))
  await runPass(discStore, { env, options: options() }, hooks())
  const discSt = discStore.status('idle').sources.find((s) => s.id === 'claude')!
  check('discovery: a listing that stops counting says "at least", and prunes nothing', [discSt.foundAtLeast, discSt.cappedBy], [true, 'discovery'])
  setDiscoveryLimitForTest(DISCOVERY_MAX_ENTRIES)
  discStore.close()

  section('a cancelled pass writes nothing half-done and prunes nothing')
  const cancelStore = ChatStore.open(join(root, 'cancel-index'))
  let n = 0
  await runPass(cancelStore, { env, options: options() }, hooks({ cancelled: () => ++n > 3 }))
  const cancelledCount = cancelStore.count()
  await runPass(cancelStore, { env, options: options() }, hooks())
  check('a later pass completes it', [cancelledCount < cancelStore.count(), cancelStore.count('claude')], [true, 10])
  cancelStore.close()
  store.close()

  section('zip reader: real archives, stored and deflated, and the ones it refuses')
  {
    const zdir = join(root, 'zips')
    mkdirSync(zdir, { recursive: true })
    const at = (name: string, buf: Buffer): string => {
      const p = join(zdir, name)
      writeFileSync(p, buf)
      return p
    }
    const refusal = (path: string, limits?: ZipLimits, entry?: string): string => {
      let z: ReturnType<typeof openZip> | null = null
      try {
        z = openZip(path, limits)
        const e = z.entries.find((x) => x.name === entry) ?? z.entries[0]
        readZipEntry(z, e, limits)
        return 'read'
      } catch (err) {
        return err instanceof ZipError ? err.message : `not a ZipError: ${(err as Error).message}`
      } finally {
        if (z) closeZip(z)
      }
    }
    const text = Buffer.from('hello from a zip — ünïcode 日本語\n'.repeat(200), 'utf8')
    for (const zip64 of [false, true]) {
      const p = at(`plain${zip64 ? '64' : ''}.zip`, makeZip([{ name: 'a/stored.txt', data: text, method: 0 }, { name: 'deflated.txt', data: text }], zip64))
      const z = openZip(p)
      const got = z.entries.map((e) => [e.name, e.method, readZipEntry(z, e).equals(text)])
      closeZip(z)
      check(`${zip64 ? 'ZIP64: ' : ''}a stored and a deflated member read back byte for byte`, got, [
        ['a/stored.txt', 0, true],
        ['deflated.txt', 8, true]
      ])
    }
    for (const name of ['../conversations.json', 'a/../../conversations.json', '/etc/conversations.json', 'C:\\conversations.json', 'a\\..\\..\\x.json']) {
      const p = at('escape.zip', makeZip([{ name: 'conversations.json', data: json([]) }, { name, data: Buffer.from('x') }]))
      check(`a name that leaves the archive refuses all of it: ${name}`, refusal(p).includes('points outside it'), true)
    }
    // 8 MiB of zeros packs to a few KB: over 200:1, and past the 1 MiB floor.
    const bomb = at('bomb.zip', makeZip([{ name: 'conversations.json', data: Buffer.alloc(8 * 1024 * 1024) }]))
    check('a member inflating past 200:1 is refused as a bomb, before inflating', refusal(bomb).includes('zip bomb'), true)
    const small: ZipLimits = { ...CHAT_EXPORT_LIMITS, memberBytes: 1024 }
    // Garbage for deflate data: had it been inflated, the error would be "could not be unpacked".
    const oversize = at('oversize.zip', makeZip([{ name: 'conversations.json', data: Buffer.from('not deflate at all '.repeat(200)), method: 0, rawMethod: 8, declaredSize: 5000 }]))
    check('a member declared over the size cap is refused before any inflate', refusal(oversize, small), '“conversations.json” is 0 MB unpacked; Stoke reads up to 0 MB.')
    const liar = at('liar.zip', makeZip([{ name: 'conversations.json', data: Buffer.from('a lying header says this is short '.repeat(300)), declaredSize: 100 }]))
    check('a header that understates the size stops the inflate at what it said', refusal(liar).includes('more than its stated size'), true)
    const many = at('many.zip', makeZip(Array.from({ length: 5 }, (_, k) => ({ name: `f${k}.txt`, data: Buffer.from('x') }))))
    check('more entries than the cap is refused before the directory is read', refusal(many, { ...CHAT_EXPORT_LIMITS, entries: 3 }).includes('lists 5 files'), true)
    check('an encrypted member is refused', refusal(at('enc.zip', makeZip([{ name: 'c.json', data: text, flags: 1 }]))).includes('encrypted'), true)
    check('an unknown compression method is refused', refusal(at('bz.zip', makeZip([{ name: 'c.json', data: text, method: 0, rawMethod: 12 }]))).includes('method 12'), true)
    check('a wrong checksum is refused', refusal(at('crc.zip', makeZip([{ name: 'c.json', data: text, badCrc: true }]))).includes('checksum'), true)
    check('a file that is not a zip is said to be one', refusal(at('not.zip', Buffer.from('just some text, long enough to have a tail'))), 'This is not a zip archive (no directory at its end).')
    const cut = makeZip([{ name: 'conversations.json', data: text }])
    check('an archive cut short is refused, not half-read', refusal(at('cut.zip', cut.subarray(0, cut.length - 30))), 'This is not a zip archive (no directory at its end).')
  }

  section('the export array is split by bytes, never one parse')
  {
    const doc = Buffer.from('\ufeff [ {"a":"x]}\\"{"}, 3, "str]", [1,{"no":1}], {"b":{"c":[1,2]}} ]', 'utf8')
    const got: string[] = []
    const res = forEachArrayObject(doc, (s, e) => got.push(doc.toString('utf8', s, e)))
    check('each top-level object, braces and quotes inside strings ignored', [got, res], [['{"a":"x]}\\"{"}', '{"b":{"c":[1,2]}}'], { count: 2, complete: true }])
    const trunc = Buffer.from('[{"a":1},{"b":', 'utf8')
    const tgot: string[] = []
    check('a file cut short keeps what came before, and says it is incomplete', [forEachArrayObject(trunc, (s, e) => tgot.push(trunc.toString('utf8', s, e))), tgot], [{ count: 1, complete: false }, ['{"a":1}']])
    let threw = false
    try {
      forEachArrayObject(Buffer.from('{"conversations": []}'), () => undefined)
    } catch {
      threw = true
    }
    check('a document that is not a list is not an export', threw, true)
  }

  section('claude.ai export: words only, the current branch, its own title and times')
  {
    const [c1, c2, c3] = claudeAiExport()
    const conv = foldClaudeAiConversation(c1, true)!
    const said = conv.fold.messages.map((m) => `${m.role}:${m.text.split(' ')[0]}`)
    check('only the branch ending at current_leaf_message_uuid, in order', said, ['user:How', 'assistant:Monotremes', 'user:currentbranchword', 'assistant:currentreplyword'])
    const all = conv.fold.messages.map((m) => m.text).join('\n')
    check(
      'no thinking, tool call, tool result, placeholder or attachment contents; the file name is kept',
      ['claudeaithinkword', 'claudeaitoolword', 'claudeaitoolresultword', 'claudeaiplaceholderword', 'attachmentcontentword', 'abandonedbranchword'].filter((w) => all.includes(w)).concat(all.includes('[Attached: burrow-notes.txt]') ? ['named'] : []),
      ['named']
    )
    check('its own title and stamps', [conv.id, conv.fold.meta.title, conv.fold.meta.createdMs, conv.fold.meta.updatedMs, conv.fold.messages[0].atMs], ['ca-1', 'Echidna planning', T0 + 1 * H, T0 + 3 * H, T0 + 1 * H])
    check('keys redacted before they are kept', all.includes('ABCDEFGHIJKLMNOPQRSTUV'), false)
    const legacy = foldClaudeAiConversation(c2, true)!
    check('an older export with no content blocks reads `text`', legacy.fold.messages.map((m) => m.text), ['flatlegacyword question', 'flatlegacyreply'])
    check('an empty conversation folds to nothing', foldClaudeAiConversation(c3, true)!.fold.messages.length, 0)
  }

  section('ChatGPT export: the mapping tree, from current_node only')
  {
    const [g1, g2] = chatgptExport()
    const conv = foldChatgptConversation(g1, true)!
    check(
      'the path from current_node to the root, in order; tool calls, tool output, system and hidden turns left out',
      conv.fold.messages.map((m) => `${m.role}:${m.text}`),
      ['user:Tell me about wombats chatgptuserword', 'assistant:Wombats dig chatgptreplyword', 'user:newbranchword with a picture', 'assistant:newbranchreplyword']
    )
    check('its title, epoch-second stamps as ms, and the model that answered last', [conv.id, conv.fold.meta.title, conv.fold.meta.createdMs, conv.fold.meta.updatedMs, conv.fold.meta.model], ['cg-1', 'Wombat facts', T0 + 5 * H, T0 + 6 * H, 'gpt-5'])
    check('with no current_node, the newest leaf is the conversation', foldChatgptConversation(g2, true)!.fold.messages.map((m) => m.text), ['leaflessquestion', 'newerleafword'])
  }

  section('importing an export: recognised by content, capped, disclosed, updated in place')
  {
    const imp = ChatStore.open(join(root, 'import-index'))
    const ok = await importExport(imp, { path: claudeZip, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    const rec = ok.ok ? ok.record : null
    check('a claude.ai zip imports', [ok.ok, rec?.kind, rec?.fileName, rec?.found, rec?.admitted, rec?.added, rec?.empty, rec?.indexed], [true, 'export-claude', 'data-2026-09-30-claude.zip', 3, 3, 2, 1, 2])
    check('...searchable, current branch only', [words(imp, 'currentbranchword'), words(imp, 'abandonedbranchword'), words(imp, 'flatlegacyword')], [['export-claude:ca-1'], [], ['export-claude:ca-2']])
    check('...the account files beside it are never read', [words(imp, 'example.com'), words(imp, 'Private')], [[], []])
    check('...an attached file is findable by name', words(imp, 'burrow notes'), ['export-claude:ca-1'])
    const c1 = imp.chat(imp.chatId('export-claude', 'ca-1')!)!
    check('...with its own title and times, no folder, and nothing to read it from but the store', [c1.title, c1.createdMs, c1.updatedMs, c1.cwd, c1.locator], ['Echidna planning', T0 + 1 * H, T0 + 3 * H, null, null])
    check('...a hit names where it came from', imp.search('currentbranchword')[0]?.source, 'export-claude')
    check('the import is disclosed in the status', imp.status('idle').imports.map((r) => [r.kind, r.indexed, importDisclosure(r, options().caps)]), [
      ['export-claude', 2, 'Imported all 3 conversations. 1 held no text and was left out.']
    ])

    const cg = await importExport(imp, { path: chatgptZip, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    check('a ChatGPT zip (ZIP64, with images beside it) imports', [cg.ok, cg.ok && cg.record.kind, cg.ok && cg.record.added], [true, 'export-chatgpt', 2])
    check('...only the current branch is searchable', [words(imp, 'newbranchreplyword'), words(imp, 'oldbranchword'), words(imp, 'chatgptcodeword'), words(imp, 'chatgptsystemword'), words(imp, 'chathtmlword')], [['export-chatgpt:cg-1'], [], [], [], []])

    // The same ids again, from a newer export: in place, never doubled.
    const newer = join(exportsDir, 'data-2026-10-07-claude.zip')
    writeFileSync(newer, makeZip([{ name: 'conversations.json', data: json(claudeAiExport({ title: 'Echidna planning, renamed', extra: 'reimportword' })) }]))
    const again = await importExport(imp, { path: newer, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    check('re-importing updates in place: same count, new words and title, old record superseded', [
      again.ok && [again.record.added, again.record.updated],
      imp.importedCount('export-claude'),
      words(imp, 'reimportword'),
      imp.chat(imp.chatId('export-claude', 'ca-1')!)?.title,
      imp.status('idle').imports.map((r) => r.fileName)
    ], [[0, 2], 2, ['export-claude:ca-1'], 'Echidna planning, renamed', ['data-2026-10-07-claude.zip', 'chatgpt-export.zip']])
    check('...and the disclosure says so', again.ok && importDisclosure(again.record, options().caps), 'Imported all 3 conversations. 2 were already here from an earlier import and were updated in place. 1 held no text and was left out.')

    // A bare conversations.json is taken too, recognised by what is in it.
    const bare = join(exportsDir, 'conversations.json')
    writeFileSync(bare, JSON.stringify(chatgptExport(), null, 2))
    const bareRes = await importExport(imp, { path: bare, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    check('a bare conversations.json imports (ChatGPT, by its mapping)', [bareRes.ok, bareRes.ok && bareRes.record.updated], [true, 2])

    const takeout = join(exportsDir, 'takeout.zip')
    writeFileSync(takeout, makeZip([{ name: 'Takeout/My Activity/Gemini Apps/MyActivity.json', data: json([{ title: 'Prompted hi' }]) }]))
    const gem = await importExport(imp, { path: takeout, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    check('a Gemini Takeout is named and refused, not guessed at', [gem.ok, !gem.ok && gem.error.startsWith('This looks like a Google Takeout (Gemini) export.')], [false, true])
    const junk = join(exportsDir, 'junk.json')
    writeFileSync(junk, JSON.stringify([{ hello: 'world' }]))
    const junkRes = await importExport(imp, { path: junk, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    check('a JSON list of something else is refused', [junkRes.ok, !junkRes.ok && junkRes.error.startsWith('No claude.ai or ChatGPT conversations')], [false, true])
    const bombRes = await importExport(imp, { path: join(root, 'zips', 'bomb.zip'), options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    // The bare file took over cg-1 and cg-2 from the ChatGPT zip, whose record then held nothing and went.
    check('a zip bomb is refused through the importer too, and nothing is written', [bombRes.ok, imp.status('idle').imports.map((r) => r.fileName)], [false, ['conversations.json', 'data-2026-10-07-claude.zip']])

    // Remove one import: its chats go, the others stay.
    const cgRec = imp.status('idle').imports.find((r) => r.kind === 'export-chatgpt')!
    imp.removeImport(cgRec.id)
    check('Remove takes that file’s chats and nothing else', [words(imp, 'newbranchreplyword'), words(imp, 'reimportword'), imp.status('idle').imports.length], [[], ['export-claude:ca-1'], 1])
    imp.close()
  }

  section('a store written before imports existed gains them in place')
  {
    // Version 1's chat table, as wave 4 shipped it: no import_id, no import_file.
    const oldDir = join(root, 'v1-index')
    mkdirSync(oldDir, { recursive: true })
    const old = new DatabaseSync(join(oldDir, 'index.sqlite'))
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema', '1');
      CREATE TABLE chat (id INTEGER PRIMARY KEY, source TEXT NOT NULL, native_id TEXT NOT NULL, title TEXT, first_prompt TEXT, cwd TEXT, git_branch TEXT, model TEXT,
        created_ms INTEGER, updated_ms INTEGER, message_count INTEGER NOT NULL DEFAULT 0, text_bytes INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0, subagent INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT, UNIQUE(source, native_id));
      INSERT INTO chat(source, native_id, title) VALUES ('claude', 'old-one', 'Kept from before');`)
    old.close()
    const up = ChatStore.open(oldDir)
    const r = await importExport(up, { path: claudeZip, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    check('the old chat is kept, the column is added, and an import lands', [up.hasChat('claude', 'old-one'), r.ok, up.importedCount()], [true, true, 2])
    up.close()
  }

  section('imports under the caps: per tool, text per chat, the total, and passes that never prune them')
  {
    // Five non-empty conversations, the newest two admitted under a per-tool cap of 2; the newest runs to ~40 KB.
    const five = Array.from({ length: 5 }, (_, k) => ({
      uuid: `cap-${k}`,
      name: `Cap ${k}`,
      created_at: iso(T0 + k * H),
      updated_at: iso(T0 + k * H),
      chat_messages: Array.from({ length: k === 4 ? 12 : 2 }, (_, j) => ({
        uuid: `c${k}m${j}`,
        sender: j % 2 ? 'assistant' : 'human',
        content: [{ type: 'text', text: `${j === 0 ? `capword${k}` : j === 11 ? 'lastcapword' : 'middle'} ${'lorem ipsum '.repeat(k === 4 ? 280 : 10)}` }],
        created_at: iso(T0 + k * H + j)
      }))
    }))
    const capZip = join(exportsDir, 'caps.zip')
    writeFileSync(capZip, makeZip([{ name: 'conversations.json', data: json(five) }]))
    const cs = ChatStore.open(join(root, 'import-caps'))
    const capOpts = options({}, { perSource: 2, chatKb: 16 })
    const r = await importExport(cs, { path: capZip, options: capOpts, maxTextBytes: BIG_TEXT }, importHooks())
    check('the newest 2 of 5, and the long one kept in part', [r.ok && [r.record.found, r.record.admitted, r.record.cappedBy, r.record.truncated], cs.importedCount('export-claude')], [[5, 2, 'perSource', 1], 2])
    check('...which ones', [words(cs, 'capword4'), words(cs, 'capword3'), words(cs, 'capword2')], [['export-claude:cap-4'], ['export-claude:cap-3'], []])
    check('...and it is said', r.ok && importDisclosure(r.record, capOpts.caps), 'Imported the newest 2 of 5 conversations (the limit is 2 per tool). 1 is kept in part (over 16 KB of text).')
    const keptText = cs.messages(cs.chatId('export-claude', 'cap-4')!).reduce((n, m) => n + Buffer.byteLength(m.text), 0)
    check(`...its text held to the per-chat cap, its opening and its end kept (kept ${keptText} bytes)`, [keptText > 8 * 1024 && keptText <= 16 * 1024, words(cs, 'lastcapword')], [true, ['export-claude:cap-4']])

    // A pass beside imports: they take their room under the total first, and no pass prunes them.
    await runPass(cs, { env, options: options({}, { total: 5 }) }, hooks())
    const st = cs.status('idle')
    check('the total counts imports: 2 imported + 3 local = 5', [cs.importedCount(), cs.count() - cs.importedCount(), st.sources.find((s) => s.id === 'claude')!.cappedBy], [2, 3, 'total'])
    await runPass(cs, { env, options: options({ sources: { ...CHAT_INDEX_DEFAULTS.sources, claude: false } }) }, hooks())
    check('a pass, even one that drops a source, never prunes an import', cs.importedCount(), 2)
    cs.clearLocal()
    check('Rebuild clears every local chat and read position, and keeps imports', [cs.count() - cs.importedCount(), cs.importedCount(), cs.getFile(claudeFile(29))], [0, 2, null])
    // Held to the total: a total of 1 leaves the newest import.
    const one = ChatStore.open(join(root, 'import-total'))
    const rt = await importExport(one, { path: capZip, options: options({}, { perSource: 2, total: 1 }), maxTextBytes: BIG_TEXT }, importHooks())
    check('an import is held to the total too, and says which cap', [rt.ok && rt.record.cappedBy, one.importedCount(), words(one, 'capword4')], ['total', 1, ['export-claude:cap-4']])
    one.close()
    cs.close()

    /*
     * Caps lowered AFTER an import: the pass holds the imports to its own caps
     * before it works out the room left for local chats. Without that, 7
     * imports under a total of 5 left a room of 0 and the pass pruned every
     * local chat, while all 7 imports stayed, over both new caps.
     */
    const low = ChatStore.open(join(root, 'import-lowered'))
    const claudeOnly = { sources: Object.fromEntries(Object.keys(CHAT_INDEX_DEFAULTS.sources).map((id) => [id, id === 'claude'])) as ChatIndexOptions['sources'] }
    const high = options(claudeOnly, { perSource: 10, total: 20 })
    const hr = await importExport(low, { path: capZip, options: high, maxTextBytes: BIG_TEXT }, importHooks())
    await importExport(low, { path: chatgptZip, options: high, maxTextBytes: BIG_TEXT }, importHooks())
    await runPass(low, { env, options: high }, hooks())
    check('under the caps they were imported under: 5 + 2 imports and 10 local chats', [low.importedCount('export-claude'), low.importedCount('export-chatgpt'), low.count() - low.importedCount()], [5, 2, 10])
    const lowered = options(claudeOnly, { perSource: 2, total: 5 })
    await runPass(low, { env, options: lowered }, hooks())
    check(
      'caps lowered: the imports are cut to 2 per tool, and local chats keep the room the total leaves (5 − 4 = 1)',
      [low.importedCount('export-claude'), low.importedCount('export-chatgpt'), low.count() - low.importedCount(), low.status('idle').sources.find((s) => s.id === 'claude')!.cappedBy],
      [2, 2, 1, 'total']
    )
    check('...the newest of each import stays', [words(low, 'capword4'), words(low, 'capword3'), words(low, 'capword2'), words(low, 'newbranchreplyword')], [['export-claude:cap-4'], ['export-claude:cap-3'], [], ['export-chatgpt:cg-1']])
    const lowRec = low.status('idle').imports.find((r) => hr.ok && r.id === hr.record.id)
    check(
      '...and the import says the rest has since left the index',
      lowRec && importDisclosure(lowRec, lowered.caps),
      'Imported all 5 conversations. 3 have since left the index — a newer import of the same conversations, the per-tool or total limit, or the index’s size ceiling.'
    )
    low.close()

    /*
     * Stopped while writing (Delete index, switch-off, quit): what was written
     * stays and the record says how far it got. It used to answer ok: true and
     * "Imported all 5 conversations." with two of them written.
     */
    const halt = ChatStore.open(join(root, 'import-stopped'))
    const wide = options({}, { perSource: 10 })
    const stopped = await importExport(halt, { path: capZip, options: wide, maxTextBytes: BIG_TEXT }, importHooks({ cancelled: () => halt.importedCount() >= 2 }))
    check('an import stopped part-way is not ok, and says how far it got', [stopped.ok, !stopped.ok && stopped.error], [
      false,
      'claude.ai export, caps.zip: The import was stopped after 2 of 5 conversations. Import the file again to finish: the ones already here are updated in place, not copied.'
    ])
    check('...what it wrote stays, newest first, and so does its record', [halt.importedCount(), words(halt, 'capword4'), words(halt, 'capword2'), halt.status('idle').imports.map((r) => [r.admitted, r.added])], [2, ['export-claude:cap-4'], [], [[5, 2]]])
    const finish = await importExport(halt, { path: capZip, options: wide, maxTextBytes: BIG_TEXT }, importHooks())
    check('importing it again finishes it, in place, and the stopped record goes', [finish.ok && [finish.record.added, finish.record.updated], halt.importedCount(), halt.status('idle').imports.length], [[3, 2], 5, 1])
    halt.close()
  }

  section('the viewer: a local chat read again from its source, an import from the store')
  {
    const vHome = join(root, 'view-home')
    const vEnv: SourceEnv = { home: vHome, env: {}, platform: process.platform }
    const vDir = join(vHome, '.claude', 'projects', '-tmp-view')
    const top = join(vDir, `${uuid(1)}.jsonl`)
    write(top, claudeChat(1, '/tmp/view', `viewerword key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV`), T0 + 60_000)
    const subFile = join(vDir, uuid(1), 'subagents', 'agent-v1.jsonl')
    write(subFile, claudeSubagentChat(2, '/tmp/view', 'viewsubword'), T0 + 2 * 60_000)
    const vs = ChatStore.open(join(root, 'view-index'))
    await runPass(vs, { env: vEnv, options: options({ subagents: true }) }, hooks())
    const subId = vs.chatId('claude', `${uuid(1)}/agent-v1`)!
    const view = { redact: true, fileBytes: 256 * 1024 * 1024 }
    const hit = vs.search('viewsubword')[0]
    check('a subagent hit opens in the viewer', chatOpenAction(hit, { installed: new Set<CodingCliId>(['claude']), resumable: resumableClis() }).kind, 'view')
    const v1 = openChat(vs, subId, vEnv, view)!
    check('...read from the file itself, both of its turns, in order', [v1.from, v1.fallback, v1.messages.map((m) => m.role), v1.messages[1]?.text], ['source', null, ['user', 'assistant'], 'subagent report viewsubword'])
    // Written to after the index read it: the viewer shows the file as it is NOW.
    appendFileSync(subFile, jl([{ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'late freshword' }] }, timestamp: iso(T0 + 3 * 60_000) }]))
    const v2 = openChat(vs, subId, vEnv, view)!
    check('...and re-read at open time, not from the index', [v2.messages.length, v2.messages[2]?.text, vs.messages(subId).length], [3, 'late freshword', 2])
    const topId = vs.chatId('claude', uuid(1))!
    const vt = openChat(vs, topId, vEnv, view)!
    check('the viewer redacts as the index does, and leaves out what the index leaves out', [vt.messages.some((m) => m.text.includes('ABCDEFGHIJKLMNOPQRSTUV')), vt.messages.some((m) => /tooloutputword|metaword|sidechainword/.test(m.text))], [false, false])
    check('...with the chat’s title, folder and stamps', [vt.title, vt.cwd, vt.messages[0].atMs], ['Title number 1', '/tmp/view', T0 + 60_000])
    const elsewhere = openChat(vs, topId, { ...vEnv, home: join(root, 'no-such-home') }, view)!
    check('a remembered path outside the tool’s root is not read: the index’s copy, and it says so', [elsewhere.from, elsewhere.fallback?.includes('index’s copy'), elsewhere.messages.length > 0], ['store', true, true])
    unlinkSync(top)
    const gone = openChat(vs, topId, vEnv, view)!
    check('an original that is gone: the index’s copy, and it says so', [gone.from, gone.fallback?.startsWith('The original is no longer where Claude Code kept it'), gone.messages.length], ['store', true, vs.messages(topId).length])
    const tiny = openChat(vs, subId, vEnv, { ...view, maxBytes: 40 })!
    check('a chat past the viewer’s cap shows its opening and its end, and says part is missing', [tiny.partial, tiny.messages.length < 3], [true, true])
    check('a chat not in the store is null', openChat(vs, 99_999, vEnv, view), null)
    const ir = await importExport(vs, { path: claudeZip, options: options(), maxTextBytes: BIG_TEXT }, importHooks())
    const importId = vs.chatId('export-claude', 'ca-1')!
    const vi = openChat(vs, importId, vEnv, view)!
    check('an import opens from the store, whole, in order, with its times', [ir.ok, vi.from, vi.fallback, vi.messages.map((m) => m.role), vi.messages[0].atMs, vi.title], [
      true,
      'store',
      null,
      ['user', 'assistant', 'user', 'assistant'],
      T0 + 1 * H,
      'Echidna planning'
    ])
    vs.close()
  }

  section('a tool’s own listing: its title and first prompt are cleaned like any message')
  {
    const read = { title: 'From the read', firstPrompt: 'read prompt', cwd: '/w', gitBranch: null, model: null, createdMs: T0, updatedMs: T0 }
    const listed = { title: `Deploy with ${FAKE_JWT} \u0002now\u0003\u0000`, firstPrompt: 'my   DB_PASSWORD=hunter22 and\n\nmore' }
    const on = mergeMeta(read, listed, true)
    check('redaction on: the listing’s title and first prompt are redacted and stripped of controls', [on.title, on.firstPrompt], ['Deploy with [redacted] now', 'my DB_PASSWORD=[redacted] and more'])
    const off = mergeMeta(read, listed, false)
    check('redaction off: kept, but still no controls or snippet marks', [off.title?.includes(FAKE_JWT), /[\u0000\u0002\u0003]/.test(off.title ?? ''), off.firstPrompt], [true, false, 'my DB_PASSWORD=hunter22 and more'])
    check('nothing listed: the read’s own fields stand', mergeMeta(read, {}, true), read)

    // Through a pass: Codex's threads table hands the first message over verbatim as `first_user_message`.
    const lHome = join(root, 'listing-home')
    const lEnv: SourceEnv = { home: lHome, env: {}, platform: process.platform }
    const lId = '019f456c-bbbb-7e83-927d-f3b8ad5ac6cf'
    const lRollout = join(lHome, '.codex', 'sessions', '2026', '09', '28', `rollout-2026-09-28T16-02-23-${lId}.jsonl`)
    write(
      lRollout,
      jl([
        { timestamp: iso(codexT), type: 'session_meta', payload: { id: lId, cwd: '/tmp/listing', timestamp: iso(codexT), source: 'vscode' } },
        { timestamp: iso(codexT + 1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'listingword question' }] } },
        { timestamp: iso(codexT + 2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'listingword answer' }] } }
      ]),
      codexT + 10_000
    )
    const ldb = new DatabaseSync(join(lHome, '.codex', 'state_5.sqlite'))
    ldb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT,
      first_user_message TEXT NOT NULL DEFAULT '', model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT)`)
    ldb
      .prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(lId, lRollout, codexT / 1000, codexT / 1000, 'vscode', '/tmp/listing', 't', 0, null, `use api_key=9f8e7d6c5b4a3210 please`, null, codexT, codexT + 10_000, `Thread ${FAKE_JWT}`)
    ldb.close()
    const ls = ChatStore.open(join(root, 'listing-index'))
    await runPass(ls, { env: lEnv, options: options({ sources: { claude: false, opencode: false, 'claude-cowork': false, zed: false, cline: false } }) }, hooks())
    const lh = ls.search('listingword')[0]
    check('a pass stores the listing’s title and first prompt cleaned', [lh?.title, lh?.firstPrompt], ['Thread [redacted]', 'use api_key=[redacted] please'])
    check('...and the title’s search row holds no part of the key', words(ls, JWT_TAIL), [])
    ls.close()
  }

  section('redaction turned on cleans what was stored without it — before anything is served as cleaned')
  {
    const rHome = join(root, 'reclean-home')
    const rEnv: SourceEnv = { home: rHome, env: {}, platform: process.platform }
    const rDir = join(rHome, '.claude', 'projects', '-tmp-reclean')
    const secretFile = join(rDir, `${uuid(701)}.jsonl`)
    const plainFile = join(rDir, `${uuid(702)}.jsonl`)
    write(
      secretFile,
      jl([
        { type: 'user', message: { role: 'user', content: 'recleanword: run PGPASSWORD=s3cretpw psql and key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV' }, cwd: '/tmp/reclean', timestamp: iso(T0), sessionId: uuid(701) },
        { type: 'assistant', timestamp: iso(T0 + 1000), message: { model: 'm', content: [{ type: 'text', text: `recleanword done, token ${FAKE_JWT}` }] } },
        { type: 'ai-title', aiTitle: `Login with ${FAKE_JWT}` }
      ]),
      T0 + 1000
    )
    write(plainFile, claudeChat(702, '/tmp/reclean', 'recleanword bystander'), T0 + 2000)
    const onlyClaude = { sources: { codex: false, opencode: false, 'claude-cowork': false, zed: false, cline: false } }
    const rs = ChatStore.open(join(root, 'reclean-index'))
    await runPass(rs, { env: rEnv, options: options({ ...onlyClaude, redact: false }) }, hooks())
    const sid = rs.chatId('claude', uuid(701))!
    const jwtTail = JWT_TAIL
    check('redaction off: the text is stored as written, and searchable', [words(rs, 's3cretpw'), words(rs, jwtTail)], [[`claude:${uuid(701)}`], [`claude:${uuid(701)}`]])
    check('...and every chat written so is counted as not cleaned', rs.staleCount(), 2)
    check('a cleaned-only search leaves those chats out, whatever matches', [rs.search('recleanword', 50, { redact: 'force' }), rs.search('s3cretpw', 50, { redact: 'force' })], [[], []])
    check('...while the local search, under the local setting, still has them', words(rs, 'recleanword').length, 2)

    // Forced open of a chat stored raw: re-read from its file with redaction on, the stored title cleaned on the way out.
    const view = { fileBytes: 256 * 1024 * 1024 }
    const fo = openChat(rs, sid, rEnv, { ...view, redact: 'force' })!
    const all = (t: { title: string | null; messages: { text: string }[] }): string => [t.title, ...t.messages.map((m) => m.text)].join('\n')
    check('a forced open re-reads the original with redaction on, whatever the setting', [fo.from, /s3cretpw|ABCDEFGHIJKLMNOPQRSTUV/.test(all(fo)), all(fo).includes(jwtTail)], ['source', false, false])
    check('...where the setting’s own open shows it as written', all(openChat(rs, sid, rEnv, { ...view, redact: false })!).includes('s3cretpw'), true)
    check('...and by the tool’s own id', openChatCleaned(rs, 'claude', uuid(701), rEnv, view)?.messages.length, 2)
    check('...an id the index does not hold is null', openChatCleaned(rs, 'claude', uuid(799), rEnv, view), null)
    renameSync(secretFile, `${secretFile}.away`)
    check('an original that is gone: the index’s RAW copy is never served as cleaned', openChat(rs, sid, rEnv, { ...view, redact: 'force' }), null)
    check('...though the local open still falls back to it', openChat(rs, sid, rEnv, { ...view, redact: false })?.from, 'store')
    renameSync(`${secretFile}.away`, secretFile)

    // Redaction on, files unchanged: nothing is re-read, and the stored text is cleaned in place.
    const pass = await runPass(rs, { env: rEnv, options: options(onlyClaude) }, hooks())
    check('turning redaction on re-read no file (both are unchanged)', pass.filesRead, 0)
    check('...yet the stored text is cleaned: the password, the key and the token are gone from search', [words(rs, 's3cretpw'), words(rs, 'ABCDEFGHIJKLMNOPQRSTUV'), words(rs, jwtTail)], [[], [], []])
    const msgs = rs.messages(sid).map((m) => m.text)
    check('...and from the text, with the names and the words around them kept', msgs, [
      'recleanword: run PGPASSWORD=[redacted] psql and key [redacted]',
      'recleanword done, token [redacted]'
    ])
    const hit = rs.search('recleanword', 50, { redact: 'force' }).find((h) => h.nativeId === uuid(701))
    check('...its title and first prompt too, and a cleaned-only search now finds both chats', [hit?.title, hit?.firstPrompt?.includes('s3cretpw'), rs.search('recleanword', 50, { redact: 'force' }).length], [
      'Login with [redacted]',
      false,
      2
    ])
    check('...and none is counted as not cleaned', rs.staleCount(), 0)
    check('the bystander chat’s text is untouched', rs.messages(rs.chatId('claude', uuid(702))!).map((m) => m.text)[0], `hello chat702 about topic702 recleanword bystander`)
    {
      // A second connection: the FTS index agrees with the rows it indexes, and the byte counts with the text.
      const peek = new DatabaseSync(rs.file)
      let integrity = 'ok'
      try {
        peek.exec("INSERT INTO message_fts(message_fts, rank) VALUES ('integrity-check', 1)")
      } catch (err) {
        integrity = (err as Error).message
      }
      const bytes = peek.prepare('SELECT c.text_bytes AS t, (SELECT COALESCE(SUM(m.bytes), 0) FROM message m WHERE m.chat_id = c.id AND m.ord >= 0) AS s FROM chat c').all() as { t: number; s: number }[]
      peek.close()
      check('the search index was rewritten with the rows (FTS5 integrity-check against its content)', integrity, 'ok')
      check('...and each chat’s byte count is its messages’ sum again', bytes.every((b) => Number(b.t) === Number(b.s)), true)
    }
    check('the index’s copy, cleaned now, is served to a forced open when the original is gone', (() => {
      renameSync(secretFile, `${secretFile}.away`)
      const t = openChat(rs, sid, rEnv, { ...view, redact: 'force' })
      renameSync(`${secretFile}.away`, secretFile)
      return [t?.from, t ? /s3cretpw|ABCDEFGHIJKLMNOPQRSTUV/.test(all(t)) : null]
    })(), ['store', false])

    // Off again, and the chat grows: it is not clean any more, and a cleaned-only search drops it until redaction is back.
    appendFileSync(secretFile, jl([{ type: 'user', message: { role: 'user', content: 'recleanword later password=Later9pw!' }, cwd: '/tmp/reclean', timestamp: iso(T0 + 5000) }]))
    utimesSync(secretFile, (T0 + 5000) / 1000, (T0 + 5000) / 1000)
    await runPass(rs, { env: rEnv, options: options({ ...onlyClaude, redact: false }) }, hooks())
    check('an append written with redaction off makes the chat not cleaned again', [rs.staleCount(), rs.search('recleanword', 50, { redact: 'force' }).map((h) => h.nativeId)], [1, [uuid(702)]])
    await runPass(rs, { env: rEnv, options: options(onlyClaude) }, hooks())
    check('...and the next pass with it on cleans the append too', [rs.staleCount(), words(rs, 'Later9pw')], [0, []])
    rs.close()
  }

  section('a store cleaned by an older rule set is cleaned again before it is served as cleaned')
  {
    const oDir = join(root, 'v2-index')
    const o = ChatStore.open(oDir)
    const meta = { title: `Old title ${FAKE_JWT}`, firstPrompt: 'old prompt', cwd: '/w', gitBranch: null, model: null, createdMs: T0, updatedMs: T0 }
    const oid = o.upsertChat('claude', 'old-v2', meta, { subagent: false, dedupeKey: null, whole: true, redact: true })
    // Text as the eight-rule set stored it: a JWT and a credential URL were not secrets to it.
    o.appendMessages(oid, [{ role: 'user', text: `oldword connect postgres://app:${fake('', 12)}@db:5432/x with ${FAKE_JWT}`, atMs: T0 }])
    o.close()
    // Back to schema 2 as it shipped: no level column, no update trigger.
    const raw = new DatabaseSync(join(oDir, 'index.sqlite'))
    raw.exec(`DROP INDEX chat_redact; ALTER TABLE chat DROP COLUMN redact_level; DROP TRIGGER message_au; UPDATE meta SET value = '2' WHERE key = 'schema'`)
    raw.close()
    const up = ChatStore.open(oDir)
    check('opened, it gains the level at 0: every chat in it counts as not cleaned', [up.staleCount(), up.search('oldword', 50, { redact: 'force' })], [1, []])
    const n = await recleanStale(up, hooks())
    const t = up.messages(oid)[0]?.text
    check('cleaned again in place under today’s rules', [n, t, up.staleCount()], [1, 'oldword connect postgres://[redacted]@db:5432/x with [redacted]', 0])
    check('...title too, and now it is served as cleaned', up.search('oldword', 50, { redact: 'force' }).map((h) => h.title), ['Old title [redacted]'])
    up.close()
    // A chat its clean does not raise (it can only be a fault) is tried once, never spun on for the rest of the pass.
    let asks = 0
    const stuck = { staleChatIds: () => [7], recleanChat: () => true } as unknown as ChatStore
    const spun = await recleanStale(stuck, { ...hooks(), cancelled: () => ++asks > 1000 })
    check('a chat the clean does not raise is tried once, not spun on', spun, 1)
  }

  section('a chat cleaned under rule set 2 is cleaned again under 3 before it is served as cleaned')
  {
    const vDir = join(root, 'v2-level-index')
    const vs = ChatStore.open(vDir)
    const meta = { title: `Keys api_key=[redacted],5b4a3210ffee`, firstPrompt: 'v2word DB_PASSWORD=Xy7&kL9#mQ2vP', cwd: '/w', gitBranch: null, model: null, createdMs: T0, updatedMs: T0 }
    const vid = vs.upsertChat('claude', 'cleaned-v2', meta, { subagent: false, dedupeKey: null, whole: true, redact: true })
    const SG = `SG.${fake('', 22)}.${fake('', 43)}`
    // Exactly what rule set 2 stored: a value cut at the comma (its tail kept), a value with a & left whole, a SendGrid key left whole.
    vs.appendMessages(vid, [{ role: 'user', text: `v2word api_key=[redacted],5b4a3210ffee DB_PASSWORD=Xy7&kL9#mQ2vP SENDGRID_API_KEY=${SG}`, atMs: T0 }])
    vs.close()
    const raw = new DatabaseSync(join(vDir, 'index.sqlite'))
    raw.exec('UPDATE chat SET redact_level = 2')
    raw.close()
    const v3 = ChatStore.open(vDir)
    check('a chat at level 2 counts as not cleaned under 3, and a cleaned-only search leaves it out', [v3.staleCount(), v3.search('v2word', 50, { redact: 'force' })], [1, []])
    const gone = { home: join(root, 'v2-level-no-home'), env: {}, platform: process.platform } as SourceEnv
    check('...and a cleaned-only open does not serve its stored copy', openChat(v3, vid, gone, { redact: 'force', fileBytes: 1 << 20 }), null)
    check('a pass cleans it again in place', await recleanStale(v3, hooks()), 1)
    check('...the tail 2 left, the & value and the SendGrid key are gone', v3.messages(vid).map((m) => m.text), ['v2word api_key=[redacted] DB_PASSWORD=[redacted] SENDGRID_API_KEY=[redacted]'])
    const served = v3.search('v2word', 50, { redact: 'force' })
    check('...and only now is it served as cleaned, title and first prompt too', [v3.staleCount(), served.map((h) => [h.title, h.firstPrompt])], [0, [['Keys api_key=[redacted]', 'v2word DB_PASSWORD=[redacted]']]])
    check('...including its stored copy', openChat(v3, vid, gone, { redact: 'force', fileBytes: 1 << 20 })?.from, 'store')
    v3.close()
  }

  section('a chat’s cleaned level only goes down on a write, and what leaves is cleaned once more')
  {
    const lv = ChatStore.open(join(root, 'level-index'))
    const meta = { title: null, firstPrompt: null, cwd: '/w', gitBranch: null, model: null, createdMs: T0, updatedMs: T0 }
    const a = lv.upsertChat('claude', 'mixed', meta, { subagent: false, dedupeKey: null, whole: true, redact: false })
    lv.appendMessages(a, [{ role: 'user', text: 'levelword raw password=Raw9pw!x', atMs: T0 }])
    // A later append written with redaction on (a pass whose clean-up was stopped before it reached this chat).
    lv.upsertChat('claude', 'mixed', meta, { subagent: false, dedupeKey: null, whole: false, redact: true })
    lv.appendMessages(a, [{ role: 'assistant', text: 'levelword clean', atMs: T0 }])
    check('an append cleaned on top of raw text leaves the chat not cleaned', [lv.staleCount(), lv.search('levelword', 50, { redact: 'force' })], [1, []])
    // A title the store was handed dirty under a cleaned flag: the way out cleans it again.
    lv.upsertChat('codex', 'handed', { ...meta, title: `Handed ${FAKE_JWT}`, firstPrompt: `first ${FAKE_JWT}` }, { subagent: false, dedupeKey: null, whole: true, redact: true })
    lv.appendMessages(lv.chatId('codex', 'handed')!, [{ role: 'user', text: 'handedword', atMs: T0 }])
    const out = lv.search('handedword', 50, { redact: 'force' })[0]
    check('a cleaned-only search cleans the title and first prompt once more on the way out', [out?.title, out?.firstPrompt], ['Handed [redacted]', 'first [redacted]'])
    lv.close()
  }

  section('an import: cleaned with the setting it ran under, and again when redaction comes on')
  {
    const iDir = join(root, 'import-reclean-index')
    const is = ChatStore.open(iDir)
    const r = await importExport(is, { path: claudeZip, options: options({ redact: false }), maxTextBytes: BIG_TEXT }, importHooks())
    const cid = is.chatId('export-claude', 'ca-1')!
    check('imported with redaction off: not cleaned, and never served as cleaned', [r.ok, is.staleCount() > 0, openChat(is, cid, env, { redact: 'force', fileBytes: 1 << 20 })], [true, true, null])
    await recleanStale(is, hooks())
    check('...cleaned in place, then served', [is.staleCount(), openChat(is, cid, env, { redact: 'force', fileBytes: 1 << 20 })?.from], [0, 'store'])
    is.close()
  }

  section('the worker: main asks, the worker reads, the main loop keeps turning')
  // A big transcript, so a pass is long enough to measure what it blocks.
  const heavy = join(projDir, `${uuid(900)}.jsonl`)
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'heavy line lorem ipsum dolor sit amet '.repeat(20) }] }, timestamp: iso(T0) })
  write(heavy, (line + '\n').repeat(Math.ceil((24 * 1024 * 1024) / (line.length + 1))), T0 + 100 * 60_000)
  const workerDir = join(userData, 'worker-index')
  write(join(userData, 'bystander.txt'), 'beside the store')
  const statuses: string[] = []
  const host = new ChatIndexHost({
    workerPath: fileURLToPath(new URL('../src/main/chatIndex/worker.ts', import.meta.url)),
    dir: workerDir,
    onStatus: (s) => statuses.push(s.state)
  })
  const emptyStatus = await host.status()
  check('a status read creates no store', [emptyStatus.chats, existsSync(join(workerDir, 'index.sqlite'))], [0, false])
  const wdet = await host.detect(env, false)
  check('detect through the worker', wdet.sources.find((s) => s.id === 'claude')?.chats, 30)
  let maxGap = 0
  let last = performance.now()
  const probe = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 1)
  const t0 = performance.now()
  const wpass = await host.scan({ env, options: options() })
  const passMs = performance.now() - t0
  clearInterval(probe)
  check('the pass ran in the worker and read the big file', (wpass?.bytesRead ?? 0) > 20 * 1024 * 1024, true)
  /*
   * Relative, not a fixed number of ms: a loaded CI runner (or Windows' coarse
   * timers) can stretch any one gap. The counterfactual is the same pass run on
   * THIS thread, measured the same way: a 24 MB transcript is one synchronous
   * read, and that is the stall the worker exists to keep off the main process.
   */
  const inThread = ChatStore.open(join(root, 'in-thread-index'))
  let ownGap = 0
  let ownLast = performance.now()
  const ownProbe = setInterval(() => {
    const now = performance.now()
    ownGap = Math.max(ownGap, now - ownLast)
    ownLast = now
  }, 1)
  await runPass(inThread, { env, options: options() }, { ...hooks(), now: Date.now, yieldTurn: () => new Promise((r) => setImmediate(r)) })
  clearInterval(ownProbe)
  inThread.close()
  check(
    `the main loop never waited on it (max gap ${maxGap.toFixed(1)} ms in the worker, ${ownGap.toFixed(1)} ms for the same pass on this thread)`,
    maxGap < Math.max(50, passMs / 3) && maxGap * 3 < ownGap,
    true
  )
  check('a second scan while one runs is queued, not doubled', await Promise.all([host.scan({ env, options: options() }), host.scan({ env, options: options() })]).then((r) => r.filter((x) => x === null).length >= 1), true)
  check('search through the worker', (await host.search('wombat', 10)).map((h) => h.source), ['codex'])
  check('a cleaned-only search through the worker (what another computer asks)', (await host.searchCleaned('wombat', 10)).map((h) => `${h.source}:${h.nativeId}`), [`codex:${codexId}`])
  {
    const opened = await host.openCleaned('codex', codexId, env, 256)
    check('...and a cleaned open by the tool’s own id', [opened?.from, opened?.messages.map((m) => m.text)], ['source', ['codex question about quokka', 'codex answer wombat']])
    check('...null for an id the index does not hold', await host.openCleaned('codex', 'no-such-thread', env, 256), null)
    // A store indexed with redaction OFF, through a worker of its own: the cleaned paths must not see it.
    const rawEnv: SourceEnv = { home: join(root, 'reclean-home'), env: {}, platform: process.platform }
    const rawHost = new ChatIndexHost({ workerPath: fileURLToPath(new URL('../src/main/chatIndex/worker.ts', import.meta.url)), dir: join(userData, 'worker-raw'), onStatus: () => undefined })
    const onlyClaude = { sources: { codex: false, opencode: false, 'claude-cowork': false, zed: false, cline: false } }
    await rawHost.scan({ env: rawEnv, options: options({ ...onlyClaude, redact: false }) })
    check('redaction off: the local search finds the raw chats, a cleaned-only one finds none', [(await rawHost.search('recleanword', 10)).length, (await rawHost.searchCleaned('recleanword', 10)).length], [2, 0])
    const rawOpen = await rawHost.openCleaned('claude', uuid(701), rawEnv, 256)
    check('...and a cleaned open re-reads the original with redaction on', [rawOpen?.from, rawOpen?.messages.some((m) => m.text.includes('s3cretpw'))], ['source', false])
    await rawHost.stop()
  }
  {
    // A second, reading connection beside the worker's (WAL allows it): the big chat's text is held to its cap.
    const peek = ChatStore.open(workerDir)
    const heavyId = peek.chatId('claude', uuid(900))
    const kept = heavyId === null ? -1 : peek.messages(heavyId).reduce((n, m) => n + Buffer.byteLength(m.text), 0)
    check(`text size: a 24 MB transcript keeps at most its ${CHAT_CAP_DEFAULTS.chatKb} KB of text (kept ${kept})`, kept > 400 * 1024 && kept <= CHAT_CAP_DEFAULTS.chatKb * 1024, true)
    check('...and is flagged as kept in part', peek.status('idle').sources.find((s) => s.id === 'claude')!.truncated >= 1, true)
    peek.close()
  }
  check('status was pushed while it ran', statuses.includes('running') && statuses.includes('idle'), true)
  {
    // An export, parsed in the worker; a second import while it runs is refused, not doubled.
    const [first, second] = await Promise.all([host.importExport(claudeZip, options()), host.importExport(chatgptZip, options())])
    check('an import runs in the worker; a second one at the same time is refused', [first.ok, !second.ok && second.error], [true, 'An import is already running.'])
    const hit = (await host.search('currentbranchword', 10))[0]
    check('...its conversations are searched with everything else', hit ? `${hit.source}:${hit.nativeId}` : null, 'export-claude:ca-1')
    const viewed = hit ? await host.open(hit.chatId, env, true, 256) : null
    check('...and open in the viewer from the store', [viewed?.from, viewed?.messages.length], ['store', 4])
    const st = await host.status()
    check('...and the status lists the import', st.imports.map((r) => [r.kind, r.indexed]), [['export-claude', 2]])
    await host.rebuild()
    check('Rebuild keeps imports', [(await host.search('currentbranchword', 10)).length, (await host.search('wombat', 10)).length], [1, 0])

    /*
     * Rebuild mid-import stops the pass only. The worker had one stop flag for
     * both, so Rebuild — which keeps imports — stopped a running one, and a
     * stop while writing was then recorded as the whole file imported.
     */
    const bulkZip = join(exportsDir, 'bulk.zip')
    const bulk = Array.from({ length: 400 }, (_, k) => ({
      uuid: `bulk-${k}`,
      name: `Bulk ${k}`,
      created_at: iso(T0 + k * 1000),
      updated_at: iso(T0 + k * 1000),
      chat_messages: [{ uuid: `bulk-${k}-m`, sender: 'human', content: [{ type: 'text', text: `bulkword number ${k}` }], created_at: iso(T0 + k * 1000) }]
    }))
    writeFileSync(bulkZip, makeZip([{ name: 'conversations.json', data: json(bulk) }]))
    const roomy = options({}, { perSource: 1000 })
    const [during] = await Promise.all([host.importExport(bulkZip, roomy), host.rebuild()])
    check('Rebuild while an import runs leaves it to finish', [during.ok, during.ok && [during.record.admitted, during.record.added]], [true, [400, 400]])
    const [cut] = await Promise.all([host.importExport(bulkZip, roomy), host.cancel()])
    check('switching chat history off stops an import, and says so', [cut.ok, !cut.ok && /stopped/.test(cut.error)], [false, true])
  }
  await host.deleteIndex()
  check('Delete index removes the store…', existsSync(workerDir), false)
  check('…and nothing beside it', readFileSync(join(userData, 'bystander.txt'), 'utf8'), 'beside the store')
  check('after delete, search is empty and status is zero', [await host.search('wombat', 10), (await host.status()).chats], [[], 0])
  check('…imports included: Delete index removes them too', [await host.search('currentbranchword', 10), (await host.status()).imports], [[], []])
  await host.stop()
} finally {
  rmSync(root, { recursive: true, force: true })
}

/*
 * A private chat's history folder (shared/privateChat.ts) is never listed, so
 * a transcript the CLI wrote despite being told not to never reaches the
 * index. Its own fixture home, so no count above can move.
 */
console.log('\na private chat is never indexed')
{
  const pRoot = mkdtempSync(join(tmpdir(), 'stoke-chat-private-'))
  try {
    const pHome = join(pRoot, 'home')
    const privateRoot = join(pRoot, 'ud', 'private')
    const ghost = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'
    const projects = join(pHome, '.claude', 'projects')
    const enc = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')
    write(join(projects, enc(join(privateRoot, ghost)), `${ghost}.jsonl`), claudeChat(901, join(privateRoot, ghost)))
    write(join(projects, enc(join(pRoot, 'work')), `${uuid(902)}.jsonl`), claudeChat(902, join(pRoot, 'work')))
    const pEnv: SourceEnv = { home: pHome, env: {}, platform: process.platform }
    const ids = (e: SourceEnv): string[] => listSource('claude', e, false, discovery(Date.now())).candidates.map((c) => c.nativeId).sort()
    check('without the private root both are listed (so the filter is what hides one)', ids(pEnv), [ghost, uuid(902)].sort())
    check('with it, only the ordinary chat', ids({ ...pEnv, privateRoots: [privateRoot] }), [uuid(902)])
  } finally {
    rmSync(pRoot, { recursive: true, force: true })
  }
}

/*
 * The tally is the LAST statement in this file and has to stay that way:
 * `process.exitCode` is set once, so an assertion below it could print FAIL and
 * still exit 0 (CLAUDE.md gotchas 50 and 62).
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
