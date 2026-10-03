/*
 * Phone access, the parts that decide what the QR code says.
 *
 * Every case here is about one shipped defect: with the defaults, "Turn on"
 * produced a link of http://127.0.0.1 and the panel drew it as a QR code under
 * "Open on your phone". The link builder now says how a link gets to the phone
 * (`reach`), never silently falls back to loopback as if it were a route, and
 * ranks LAN interfaces so a Docker bridge cannot outrank Wi-Fi. Hermetic: the
 * interface table and the tailnet address are injected.
 *
 *   node scripts/verify-remote.mts
 */
import { connectTarget, lanAddresses } from '../src/main/remote/link.ts'
import { exitError, installHint } from '../src/main/remote/tunnel.ts'
import {
  classifyHostname,
  createdAlready,
  createdId,
  originCertPath,
  parseTunnelList
} from '../src/main/remote/cloudflare.ts'
import { clampPort, clampRemoteReach, REMOTE_REACH_PREFERENCES } from '../src/shared/ui.ts'
import {
  advertisedRemoteToken,
  answerVerdict,
  chatsRouteFor,
  ENDED_RETENTION_MS,
  isEndedExpired,
  isGatedRemotePath,
  isTerminalReport,
  accessRefusalMessage,
  mayStoreKeyCookie,
  phoneHostDefaults,
  agentChoicesFor,
  hostChoices,
  phoneAgentChoices,
  phoneLaunchVerdict,
  type PhoneAgentChoices,
  type PhoneLaunchFacts,
  EMPTY_REMOTE_PUSH,
  hydrateRemotePush,
  livePushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS,
  pushEndpointOk,
  pushFor,
  pushPayload,
  pushStateOf,
  pushSubscriptionFrom,
  pushSubscriptionKey,
  rememberGonePush,
  MAX_GONE_PUSH,
  withPushSubscription,
  type PushState,
  refusalStatusLine,
  remoteRefusal,
  phoneStatusFor,
  PROMPT_SETTLE_MS,
  resumeVerdict,
  shouldRestartRemote,
  sortSessionRows,
  staticCacheControl,
  staticMissAnswer,
  stripLocalHostnameSuffix,
  SUBMIT_CHUNK,
  SubmitQueue,
  submitFrames,
  trackBracketedPaste,
  trackPrompt,
  typingChunks,
  type PromptTrack
} from '../src/shared/remotePhone.ts'
import {
  folderDepth,
  isPlainFolderPath,
  newFolderNameProblem,
  remoteFolderBases,
  remoteFolderVerdict,
  type FolderBase
} from '../src/shared/remotePhone.ts'
import { isInside, pathRulesFor } from '../src/shared/paths.ts'
import { CLI_CAPS } from '../src/shared/codingClis.ts'
import { privateLaunchProblem } from '../src/shared/privateChat.ts'
import { phonePickerGroups } from '../src/shared/phoneUi.ts'
import { browseRemoteFolder, listSubfolders, resolveFolderBases } from '../src/main/remote/folders.ts'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type ECDH,
  type KeyObject
} from 'node:crypto'
import { encryptPush, generateVapidKeys, isVapidPair, sendPush, VAPID_SUBJECT, vapidJwt } from '../src/main/remote/push.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { transcribe } from '../src/main/stt.ts'
import {
  ACCESS_LEEWAY_S,
  AccessKeySet,
  decodeAccessJwt,
  discoverAccess,
  EMPTY_RETRY_MS,
  KID_COOLDOWN_MS,
  keysTtlFrom,
  MAX_ACCESS_TOKEN_CHARS,
  MAX_JWKS_BYTES,
  MAX_STALE_MS,
  parseJwks,
  verifyAccessJwt
} from '../src/main/remote/accessJwt.ts'
import {
  accessCertsUrl,
  accessPolicyOf,
  accessRefusalForPhone,
  type AccessRefusal,
  clampAccessAud,
  clampAccessTeamDomain,
  parseAccessRedirect
} from '../src/shared/cfAccess.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const base = { hostname: '', port: 7878, token: 'k3y', bindLan: false, bindTailscale: false }

console.log('\nwhere the link goes, in order of preference')
check(
  'nothing configured is loopback, and says so rather than pretending it is a route',
  connectTarget({ ...base, lan: ['192.168.1.20'], tailnet: null }).reach,
  'loopback'
)
check(
  'the loopback link still carries the key, for a browser on this machine',
  connectTarget({ ...base, lan: [], tailnet: null }).url,
  'http://127.0.0.1:7878/?k=k3y'
)
check(
  'the LAN when asked for',
  connectTarget({ ...base, bindLan: true, lan: ['192.168.1.20', '10.0.0.5'], tailnet: null }),
  {
    url: 'http://192.168.1.20:7878/?k=k3y',
    reach: 'lan',
    address: '192.168.1.20',
    candidates: ['http://10.0.0.5:7878/?k=k3y']
  }
)
check(
  'the LAN asked for but no address found falls to loopback, not to a blank',
  connectTarget({ ...base, bindLan: true, lan: [], tailnet: null }).reach,
  'loopback'
)
check(
  'the tailnet beats the LAN sweep',
  connectTarget({ ...base, bindTailscale: true, lan: ['192.168.1.20'], tailnet: '100.101.102.103' }),
  { url: 'http://100.101.102.103:7878/?k=k3y', reach: 'tailnet', address: '100.101.102.103', candidates: ['http://192.168.1.20:7878/?k=k3y'] }
)
check(
  'tailscale ticked but not running is loopback, which the panel turns into a warning',
  connectTarget({ ...base, bindTailscale: true, lan: [], tailnet: null }).reach,
  'loopback'
)
check(
  'with the LAN open the tailnet is not a separate listener, so the LAN link is the one offered',
  connectTarget({ ...base, bindLan: true, bindTailscale: true, lan: ['192.168.1.20'], tailnet: '100.64.0.9' }).reach,
  'lan'
)
/*
 * This case used to assert the opposite, and it was pinning a bug as correct
 * (gotcha 10's lesson): a *saved* hostname beat a bound LAN, so a machine that
 * had typed a hostname once and never run a tunnel drew a QR code of
 * `https://<host>/` while the server listened on 192.168.x and nothing served
 * that name. A hostname is a fact about a config file; only a RUNNING tunnel is
 * a fact about right now.
 */
check(
  'a saved hostname does NOT beat the LAN the socket is actually bound to',
  connectTarget({ ...base, hostname: 'code.example.com', bindLan: true, lan: ['192.168.1.20'], tailnet: null }),
  { url: 'http://192.168.1.20:7878/?k=k3y', reach: 'lan', address: '192.168.1.20', candidates: [] }
)
check(
  'nor does it beat loopback when nothing is bound — auto never invents a tunnel',
  connectTarget({ ...base, hostname: 'code.example.com', lan: ['192.168.1.20'], tailnet: null }).reach,
  'loopback'
)
check(
  'a running quick tunnel beats everything, and its link carries the key',
  connectTarget({
    ...base,
    hostname: 'code.example.com',
    tunnelUrl: 'https://tired-owl-1234.trycloudflare.com/',
    lan: [],
    tailnet: null
  }),
  {
    url: 'https://tired-owl-1234.trycloudflare.com/?k=k3y',
    reach: 'tunnel',
    address: 'tired-owl-1234.trycloudflare.com',
    candidates: []
  }
)
check(
  'the key is URL-encoded',
  connectTarget({ ...base, token: 'a b&c', lan: [], tailnet: null }).url,
  'http://127.0.0.1:7878/?k=a%20b%26c'
)

console.log('\nan explicit choice is honoured, and is the thing that can be swapped')
/*
 * The choice used to be inferred from two booleans plus a non-empty hostname,
 * which cannot express "I have a tunnel configured and right now I want the
 * LAN" — so the picker stuck on Cloudflare Tunnel and no other segment could
 * take. Each preference is asserted BOTH ways: honoured when it can be served,
 * and falling to loopback rather than silently substituting another transport.
 */
const configured = { ...base, hostname: 'code.example.com', bindLan: true, lan: ['192.168.1.20'], tailnet: '100.64.0.9' }
check(
  'tunnel chosen uses the hostname even with a LAN address to hand',
  connectTarget({ ...configured, reach: 'tunnel' }).url,
  'https://code.example.com/?k=k3y'
)
check(
  'LAN chosen wins over a configured hostname — this is the swap that was impossible',
  connectTarget({ ...configured, reach: 'lan' }),
  { url: 'http://192.168.1.20:7878/?k=k3y', reach: 'lan', address: '192.168.1.20', candidates: [] }
)
check(
  'tailnet chosen wins over both',
  connectTarget({ ...configured, reach: 'tailnet' }).address,
  '100.64.0.9'
)
/*
 * This used to assert 'lan' — "a choice needs no bind flag" — which pinned the
 * phone QA's bug as correct: a stale reach 'lan' with bindLan false drew a QR
 * for 192.168.x:7941 while the server listened on 127.0.0.1 only.
 */
check(
  'a LAN choice the socket is not bound for is loopback (no QR), not a link nothing serves',
  connectTarget({ ...configured, reach: 'lan', bindLan: false }).reach,
  'loopback'
)
check(
  'a tailnet choice with neither bind is loopback too',
  connectTarget({ ...configured, reach: 'tailnet', bindLan: false, bindTailscale: false }).reach,
  'loopback'
)
check(
  'and with the tailnet listener alone it is the tailnet',
  connectTarget({ ...configured, reach: 'tailnet', bindLan: false, bindTailscale: true }).reach,
  'tailnet'
)
check(
  'tunnel chosen with no hostname is loopback, so the panel can say why',
  connectTarget({ ...base, reach: 'tunnel', lan: ['192.168.1.20'], tailnet: '100.64.0.9' }).reach,
  'loopback'
)
check(
  'tailnet chosen with Tailscale down is loopback, not a silent fall to the LAN',
  connectTarget({ ...base, reach: 'tailnet', lan: ['192.168.1.20'], tailnet: null }).reach,
  'loopback'
)
check(
  'LAN chosen with no address is loopback',
  connectTarget({ ...base, reach: 'lan', lan: [], tailnet: null }).reach,
  'loopback'
)
check(
  'a RUNNING tunnel still beats an explicit LAN — it is a fact about now, not a file',
  connectTarget({ ...configured, reach: 'lan', tunnelUrl: 'https://x.trycloudflare.com' }).reach,
  'tunnel'
)
check(
  'auto is the default when the field is absent, and behaves as the binds say',
  connectTarget({ ...configured, bindLan: true }).reach,
  'lan'
)

console.log('\nthe preference vocabulary repairs junk rather than meaning loopback')
check('an unknown value is auto', clampRemoteReach('banana'), 'auto')
check('so is undefined, which is every settings file written before this', clampRemoteReach(undefined), 'auto')
check('and each real value survives', REMOTE_REACH_PREFERENCES.map(clampRemoteReach).join(','), 'auto,lan,tailnet,tunnel')

console.log('\nwhich LAN address a phone can actually dial')
const nets = {
  bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  utun3: [{ address: '100.101.1.2', family: 'IPv4', internal: false }],
  en5: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
  en0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.1.20', family: 'IPv4', internal: false }
  ],
  'vEthernet (Default Switch)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }]
}
check(
  'Wi-Fi first, then an unnamed adapter, then the bridges and VMs last',
  lanAddresses(nets),
  ['192.168.1.20', '10.0.0.7', '192.168.64.1', '172.20.0.1']
)
check('loopback is never a candidate', lanAddresses(nets).includes('127.0.0.1'), false)
check('the tailnet address is never a LAN candidate; it is its own route', lanAddresses(nets).includes('100.101.1.2'), false)
check('node 18 reports family as a number, and that still counts', lanAddresses({ eth0: [{ address: '10.1.1.1', family: 4, internal: false }] }), ['10.1.1.1'])
check('no interfaces is an empty list, not a throw', lanAddresses({}), [])

console.log('\nwhat a dead tunnel reports')
check(
  'the last line that looks like a reason is quoted',
  exitError(1, [
    '2026-09-02T02:00:00Z INF Starting tunnel',
    '2026-09-02T02:00:01Z ERR Cannot determine default origin certificate path. No file cert.pem in [~/.cloudflared]',
    '2026-09-02T02:00:01Z INF Shutting down'
  ]),
  'cloudflared exited with code 1: Cannot determine default origin certificate path. No file cert.pem in [~/.cloudflared]'
)
check('with no reason in the log, the code alone', exitError(1, []), 'cloudflared exited with code 1')
check('the last plain line stands in when nothing is marked as an error', exitError(2, ['starting', 'tunnel stoke not found']), 'cloudflared exited with code 2: tunnel stoke not found')
check('the install hint names the package manager per platform', [installHint('darwin'), installHint('win32')], ['brew install cloudflared', 'winget install Cloudflare.cloudflared'])

console.log('\nreading cloudflared, where every naive reading is wrong')
/*
 * All three of these were measured against cloudflared 2026.6.1, and all three
 * make a plain implementation report the opposite of the truth.
 */
/*
 * The CLI writes "no tunnels matched" as the literal string `null`, not as
 * `[]`. Reading that as "unreadable" is what made the panel say "Cloudflare
 * answered with something this version could not read" for the perfectly
 * ordinary case of not having created the tunnel yet — measured against a real
 * account, which is the only way it would ever have been seen.
 */
check('no match is the literal string null, which means none', parseTunnelList('null'), [])
check('and empty output means none as well', parseTunnelList('   '), [])
check('while genuinely unreadable output stays null, which is a third answer', parseTunnelList('<html>502</html>'), null)
check('a match comes back as id and name', parseTunnelList('[{"id":"abc","name":"code","created_at":"x"}]'), [
  { id: 'abc', name: 'code' }
])
check('two of them keep their order', parseTunnelList('[{"id":"a","name":"one"},{"id":"b","name":"two"}]')?.length, 2)
check('junk is not a list', parseTunnelList('not json at all'), null)
check(
  'an entry missing its name is dropped rather than read as undefined',
  parseTunnelList('[{"id":"a"},{"id":"b","name":"two"}]'),
  [{ id: 'b', name: 'two' }]
)

/*
 * `tunnel create` on a name that is taken exits non-zero. Reporting that as a
 * failure leaves the wizard sitting on a red step for a tunnel the user has.
 */
check(
  'a taken name is the thing we wanted, not an error',
  createdAlready('failed to create tunnel: tunnel with name already exists'),
  true
)
check('a real failure is not', createdAlready('Cannot determine default origin certificate path'), false)
check(
  'the uuid is read out of the success line',
  createdId('Created tunnel code with id 0f5a6b7c-1234-4abc-9def-0123456789ab'),
  '0f5a6b7c-1234-4abc-9def-0123456789ab'
)
check('and absent when it did not say one', createdId('something else entirely'), null)

console.log('\nwhat the public hostname answers, which is the only 1033 detector there is')
/*
 * Cloudflare serves error 1033 — "routed to a tunnel with no connections" — as
 * HTTP 530. It is the single most useful thing this panel can report, because
 * Stoke can produce that state by itself: `tunnel route dns` refuses to
 * overwrite an existing record, so a hostname that ever pointed anywhere keeps
 * pointing there while Stoke runs a different tunnel and draws a QR code for
 * the name. Reported live as "even when it is running I'm getting 1033".
 */
check('530 is 1033, whatever the body says', classifyHostname(530, null, ''), 'tunnel-not-found')
check('and the body alone is enough', classifyHostname(200, null, '<h1>Error 1033</h1>'), 'tunnel-not-found')
check('as is the phrase Cloudflare puts above it', classifyHostname(200, null, 'Argo Tunnel error'), 'tunnel-not-found')
/*
 * Access is not a failure and must not be reported as success either: Stoke
 * cannot see past the login, and 1033 is perfectly capable of waiting on the
 * other side of it.
 */
check(
  'a redirect to the Access login is its own answer',
  classifyHostname(302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x', ''),
  'access'
)
check('an ordinary redirect is not Access', classifyHostname(302, 'https://example.com/', ''), 'ok')
check('a 200 means something answered', classifyHostname(200, null, 'hello'), 'ok')
/*
 * 401 is OUR server asking for the key, so for the question "does this hostname
 * reach this machine" it is a yes, not a failure.
 */
check('and a 401 is our own server asking for the key', classifyHostname(401, null, ''), 'ok')
check('a 502 is something else again', classifyHostname(502, null, 'bad gateway'), 'other')

console.log('\nwhere the login certificate lives')
// The home is this machine's, so the answer is joined with its separator: the
// expectation is built the same way, or Windows reads `\home\x\...` against a
// POSIX literal.
check(
  'the default is the CLI\'s own',
  originCertPath({}, '/home/x'),
  join('/home/x', '.cloudflared', 'cert.pem')
)
check(
  'and TUNNEL_ORIGIN_CERT overrides it, because cloudflared honours it',
  originCertPath({ TUNNEL_ORIGIN_CERT: '/tmp/other.pem' }, '/home/x'),
  '/tmp/other.pem'
)
check('an empty override is not an override', originCertPath({ TUNNEL_ORIGIN_CERT: '  ' }, '/home/x'), join('/home/x', '.cloudflared', 'cert.pem'))

console.log('\nthe port box')
check('a real port is kept', clampPort(8080), 8080)
check('the default when cleared', clampPort(''), 7878)
check('a privileged port is refused', clampPort(80), 7878)
check('so is one past the top', clampPort(65536), 7878)
check('a string from an input box is read', clampPort('9000'), 9000)
check('a fraction is refused', clampPort(8080.5), 7878)

console.log('\nthe phone contract\'s pure pieces (server.ts / phone contract)')
/*
 * PX-2: the list used to show no status at all. `shell` counts as busy —
 * the CLI's own name for "a command is running" — and a non-Claude CLI, which
 * writes no registry file, can never be more precise than 'unknown'.
 */
check('waiting outranks everything', phoneStatusFor({ exited: false, instrumented: true, registryStatus: 'waiting' }), 'waiting')
check('shell counts as busy', phoneStatusFor({ exited: false, instrumented: true, registryStatus: 'shell' }), 'busy')
check('busy is busy', phoneStatusFor({ exited: false, instrumented: true, registryStatus: 'busy' }), 'busy')
check('idle is idle', phoneStatusFor({ exited: false, instrumented: true, registryStatus: 'idle' }), 'idle')
check('no reading yet is unknown, not idle', phoneStatusFor({ exited: false, instrumented: true, registryStatus: null }), 'unknown')
check('another CLI writes no registry file, so it is always unknown', phoneStatusFor({ exited: false, instrumented: false, registryStatus: 'busy' }), 'unknown')
check('exited outranks a stale busy reading', phoneStatusFor({ exited: true, instrumented: true, registryStatus: 'busy' }), 'ended')

check(
  'rows sort waiting, busy, idle, unknown, ended, most recent first within a bucket',
  sortSessionRows([
    { id: 'a', status: 'idle', lastActivityAt: 1000 },
    { id: 'b', status: 'waiting', lastActivityAt: 500 },
    { id: 'c', status: 'ended', lastActivityAt: 2000 },
    { id: 'd', status: 'busy', lastActivityAt: 100 },
    { id: 'e', status: 'idle', lastActivityAt: 3000 },
    { id: 'f', status: 'unknown', lastActivityAt: 400 }
  ]).map((r) => r.id),
  ['b', 'd', 'e', 'a', 'f', 'c']
)
check('a null lastActivityAt sorts as never', sortSessionRows([
  { id: 'a', status: 'idle', lastActivityAt: null },
  { id: 'b', status: 'idle', lastActivityAt: 1 }
]).map((r) => r.id), ['b', 'a'])

/*
 * F1: a session that exits on its own used to vanish from the map at once,
 * so the phone could never learn a real crash happened. Kept for
 * ENDED_RETENTION_MS. `isEndedExpired` is the predicate `PtyManager.pruneEnded`
 * itself calls (the earlier shared `pruneEnded` was tested here and called by
 * nothing), on a fake clock (gotcha 74).
 */
{
  const now = ENDED_RETENTION_MS + 1
  check('an entry past the retention window is dropped', isEndedExpired(0, now), true)
  check('one still inside it survives', isEndedExpired(ENDED_RETENTION_MS - 1000, now), false)
  check('a running session (no endedAt) never expires', isEndedExpired(null, Number.MAX_SAFE_INTEGER), false)
  check('the retention window is ten minutes', ENDED_RETENTION_MS, 10 * 60 * 1000)
}

/*
 * PX-1 and gotcha 86. The composer used to send the text and Enter as one
 * chunk: the `\r` inside it became a newline in Claude Code's box. The first
 * fix bracketed the text as a paste — and Claude Code then filed every phone
 * message as `<pasted_content>` that the model would not act on. Now: typed
 * chunks, no brackets for Claude, newlines as ESC CR, Enter on its own.
 */
check(
  'Claude: a short line is one typed chunk, no paste brackets, Enter separate',
  submitFrames('hello', { bracketedPaste: true, claude: true }),
  { chunks: ['hello'], enter: '\r' }
)
check(
  'Claude: never bracketed, even with DECSET 2004 on (the <pasted_content> refusal)',
  submitFrames('x'.repeat(200), { bracketedPaste: true, claude: true }).chunks.some((c) => c.includes('\u001b[200~')),
  false
)
check(
  'Claude: a long line is typed in chunks of at most SUBMIT_CHUNK',
  submitFrames('y'.repeat(150), { bracketedPaste: true, claude: true }).chunks.map((c) => c.length),
  [SUBMIT_CHUNK, SUBMIT_CHUNK, 150 - 2 * SUBMIT_CHUNK]
)
check(
  'Claude: newlines become ESC CR (meta-Enter), so they break the line instead of submitting',
  submitFrames('line one\nline two\r\nthree', { bracketedPaste: true, claude: true }).chunks.join(''),
  'line one\u001b\rline two\u001b\rthree'
)
check(
  'a chunk boundary never splits ESC from its CR (half of it is a bare Escape)',
  typingChunks('abc\u001b\rdef', 4),
  ['abc', '\u001b\rde', 'f']
)
check(
  'a chunk boundary never splits a surrogate pair',
  typingChunks('ab\u{1F600}cd', 3),
  ['ab', '\u{1F600}c', 'd']
)
check(
  'another agent: one line is typed plainly',
  submitFrames('hello', { bracketedPaste: true, claude: false }),
  { chunks: ['hello'], enter: '\r' }
)
check(
  'another agent: several lines go inside bracketed paste when the pty has it on',
  submitFrames('a\nb', { bracketedPaste: true, claude: false }).chunks,
  ['\u001b[200~a\nb\u001b[201~']
)
check(
  'another agent with bracketed paste off: plain',
  submitFrames('a\nb', { bracketedPaste: false, claude: false }).chunks,
  ['a\nb']
)

check('DECSET 2004 on is read from the stream', trackBracketedPaste('\u001b[?2004h', false), true)
check('and off turns it back off', trackBracketedPaste('\u001b[?2004l', true), false)
check('the last one in a chunk wins', trackBracketedPaste('\u001b[?2004h text \u001b[?2004l', true), false)
check('a chunk with neither leaves it alone', trackBracketedPaste('just output', true), true)

check('/api/* stays gated', isGatedRemotePath('/api/sessions'), true)
check('the shell is public', isGatedRemotePath('/'), false)
check('assets are public', isGatedRemotePath('/assets/app.js'), false)
check('the manifest is public', isGatedRemotePath('/manifest.webmanifest'), false)
check('an unmatched path falls to the public SPA shell, not to a 401', isGatedRemotePath('/session/abc'), false)
check('the service worker is public too: a phone must load it before it has a key', isGatedRemotePath('/sw.js'), false)

console.log('\nchat history is the relay’s, never the phone’s (spec 2026-10-03 §3)')
// A phone holds only the bearer key; chat history is read by another of the owner's
// computers through a chats relay its host judged. The phone server's instance answers
// every /api/chats/* with the 404 of any unknown endpoint.
check(
  'the phone’s instance serves no chats route, whatever the method or spelling',
  ['/api/chats/search', '/api/chats/open', '/api/chats', '/api/chats/', '/api/chats/search/'].flatMap((p) => ['GET', 'POST'].map((m) => chatsRouteFor('phone', m, p))),
  Array(10).fill('none')
)
check('the relay’s instance serves exactly the two GETs', [chatsRouteFor('relay', 'GET', '/api/chats/search'), chatsRouteFor('relay', 'GET', '/api/chats/open')], ['search', 'open'])
check('and nothing else under it, nor a write', [chatsRouteFor('relay', 'POST', '/api/chats/search'), chatsRouteFor('relay', 'GET', '/api/chats/delete'), chatsRouteFor('relay', 'GET', '/api/chats/search/x')], ['none', 'none', 'none'])
check('every other path is not a chats path at all, on either instance', [chatsRouteFor('phone', 'GET', '/api/sessions'), chatsRouteFor('relay', 'GET', '/api/chatsearch'), chatsRouteFor('relay', 'GET', '/chats/search')], ['not-chats', 'not-chats', 'not-chats'])
{
  // Main wires the chats deps into the relay instance only: a `serveChats` on the phone's
  // `remote` would make every route above answer on the phone's server.
  const main = readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8')
  // Any receiver, optional chaining included (`remote?.serveChats(`).
  const calls = [...main.matchAll(/([\w$]+)\s*\??\.\s*serveChats\s*\(/g)].map((m) => m[1])
  check('main calls serveChats on the relay instance alone', calls, ['relayServer'])
  // And what it serves is the index's CLEANED reads (spec 2026-10-03 §1): never the local
  // `search`/`open`, which follow this computer's own redaction setting and would search raw rows.
  const seam = main.slice(main.indexOf('function chatIndexForGuests('), main.indexOf('\n}\n', main.indexOf('function chatIndexForGuests(')))
  check(
    'the chats it serves are the index’s cleaned search and open, never the local ones',
    [/search:\s*\([^)]*\)\s*=>\s*chatHost\(\)\.searchCleaned\(/.test(seam), /open:\s*\([^)]*\)\s*=>\s*chatHost\(\)\.openCleaned\(/.test(seam), /chatHost\(\)\.(search|open)\(/.test(seam)],
    [true, true, false]
  )
  // Review of db1ae51: nothing is served while this computer's redaction is off (chats stored then are raw,
  // the cleaned search finds none, and a guest was told they are not here), and the owner's hidden folders
  // go to the index so a hidden chat takes no place before its limit.
  check(
    'the seam reads redaction per call and hands the index the hidden folders',
    [/redactOn:\s*\(\)\s*=>\s*getSettings\(\)\.chatIndexOptions\.redact\b/.test(seam), /searchCleaned\(\s*q\s*,\s*limit\s*,\s*getSettings\(\)\.hiddenProjects\s*\)/.test(seam)],
    [true, true]
  )
  // And HubRemote is told the same, so a redaction-off host advertises nothing and refuses every chats relay.
  const hubDeps = main.slice(main.indexOf('chatIndexOn: () =>'), main.indexOf('await svc.start()', main.indexOf('chatIndexOn: () =>')))
  check('the hub service’s machine deps read redaction per call too', /chatRedactOn:\s*\(\)\s*=>\s*getSettings\(\)\.chatIndexOptions\.redact\b/.test(hubDeps), true)
  const server = readFileSync(join(import.meta.dirname, '../src/main/remote/server.ts'), 'utf8')
  check('and the server asks chatsRouteFor which instance it is from that alone', /chatsRouteFor\(this\.relayChats \? 'relay' : 'phone'/.test(server), true)
}

console.log('\nthe phone shell: static answers, caching, and the service worker')
// A missing FILE used to get index.html with a 200: a module loader ran HTML as
// a script, and a service worker asking for /sw.js from a build without one
// would have registered the shell as its script.
check(
  'a path naming no file is a page, and gets the shell',
  ['/', '/session/abc', '/index.html', '/history/p/x/'].map(staticMissAnswer),
  ['shell', 'shell', 'shell', 'shell']
)
check(
  'a missing file is a 404: an old bundle hash, the worker, an icon, anything with an extension',
  ['/assets/index-OLDHASH.js', '/sw.js', '/icon-999.png', '/manifest.webmanifest', '/favicon.ICO'].map(staticMissAnswer),
  ['not-found', 'not-found', 'not-found', 'not-found', 'not-found']
)
check(
  'hashed /assets/ are kept for good; the shell, the worker and the manifest are revalidated',
  ['/assets/index-DtCA4skw.js', '/', '/index.html', '/sw.js', '/manifest.webmanifest', '/icon-192.png'].map((p) =>
    staticCacheControl(p).includes('immutable')
  ),
  [true, false, false, false, false, false]
)

{
  const swSource = readFileSync(new URL('../src/remote/public/sw.js', import.meta.url), 'utf8')
  check(
    "sw.js keeps both markers vite.remote.config.ts stamps (without them the worker never changes, so never updates)",
    [swSource.split("'__STOKE_BUILD__'").length - 1, swSource.split('/* __STOKE_PRECACHE__ */ []').length - 1],
    [1, 1]
  )
  const ORIGIN = 'https://phone.example'
  const listeners = new Map<string, (event: unknown) => void>()
  // Holds the Response itself, URL and all, as Cache Storage does: `put` keeps a
  // response's URL list whatever key it is filed under, and `match` hands it back.
  const store = new Map<string, Response>()
  const cacheNames = new Set<string>()
  let network: (url: string) => Promise<Response> = () => Promise.reject(new TypeError('offline'))
  let fetched: string[] = []
  const keyOf = (r: string | { url: string }): string => (typeof r === 'string' ? r : r.url)
  const cache = {
    match: async (r: string | { url: string }) => store.get(keyOf(r))?.clone(),
    put: async (r: string | { url: string }, res: Response) => void store.set(keyOf(r), res),
    addAll: async () => {}
  }
  /*
   * What `fetch` really answers: a Response whose `url` is the URL it fetched,
   * through every `clone()`. A synthetic `new Response()` has `url === ''`, so a
   * suite that stubs the network with one can never see a URL kept in the cache —
   * which is how "a ?k= key never lands in Cache Storage" passed here while the
   * worker stored the `?k=` navigation's own response, key in its `.url`.
   */
  const fromNetwork = (url: string, res: Response): Response => {
    const clone = res.clone.bind(res)
    Object.defineProperty(res, 'url', { value: url })
    Object.defineProperty(res, 'clone', { value: () => fromNetwork(url, clone()) })
    return res
  }
  // `keepShell` reads the body before it stores anything: let that finish.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      registration: { scope: `${ORIGIN}/` },
      location: { origin: ORIGIN },
      clients: { claim: async () => {} },
      skipWaiting: async () => {}
    },
    caches: {
      open: async (name: string) => (cacheNames.add(name), cache),
      keys: async () => [...cacheNames],
      delete: async (name: string) => cacheNames.delete(name)
    },
    fetch: (r: string | { url: string }) => {
      fetched.push(keyOf(r))
      return network(keyOf(r))
    },
    URL,
    Response,
    Promise,
    // The shell's stall timer must not hold this suite open for its 4s.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref()
  }
  runInNewContext(swSource, sandbox)
  const route = sandbox.route as (pathname: string, scopePath: string, navigate: boolean) => string | null
  check(
    'never /api or /ws: every byte of session data, and the key, goes to the computer every time',
    ['/api', '/api/sessions', '/api/theme', '/ws', '/ws/events'].map((p) => route(p, '/', true)),
    [null, null, null, null, null]
  )
  check('nor the worker itself', route('/sw.js', '/', false), null)
  check(
    'the shell, the hashed assets and the manifest and icons are its only business',
    ['/', '/index.html', '/assets/index-x.js', '/manifest.webmanifest', '/icon-192.png', '/icon-180.png'].map((p) => route(p, '/', false)),
    ['shell', 'shell', 'asset', 'static', 'static', 'static']
  )
  check(
    'an SPA page is the shell only as a navigation; any other file is left alone',
    [route('/session/abc', '/', true), route('/session/abc', '/', false), route('/notes.txt', '/', true)],
    ['shell', null, null]
  )
  check(
    'under a path scope, /api below it is still left alone, and nothing outside the scope is touched',
    [route('/stoke/api/sessions', '/stoke/', false), route('/stoke/', '/stoke/', true), route('/other/', '/stoke/', true)],
    [null, 'shell', null]
  )

  const fire = (method: string, url: string, mode = 'no-cors'): Promise<Response> | null => {
    let answered: Promise<Response> | null = null
    listeners.get('fetch')?.({ request: { method, url, mode }, respondWith: (p: Promise<Response>) => (answered = p) })
    return answered
  }
  check(
    'the fetch handler never answers /api, /ws, a POST or another origin',
    [
      fire('GET', `${ORIGIN}/api/sessions`),
      fire('GET', `${ORIGIN}/ws?ptyId=x`),
      fire('POST', `${ORIGIN}/`, 'navigate'),
      fire('GET', 'https://elsewhere.example/assets/a.js')
    ].map((p) => p === null),
    [true, true, true, true]
  )
  const html = (body: string): Response => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  network = async (url) => fromNetwork(url, html('<p>new shell</p>'))
  const online = await fire('GET', `${ORIGIN}/?k=SECRETKEY`, 'navigate')!
  check('online, the shell comes from the network (a Stoke update lands on the next load)', await online.text(), '<p>new shell</p>')
  await settle()
  check(
    "and is kept under the one fixed key with no URL: neither the key nor the stored response's .url carries the ?k=",
    [...store.entries()].map(([k, res]) => [k, k.includes('SECRETKEY'), res.url]),
    [[`${ORIGIN}/index.html`, false, '']]
  )
  check(
    "the page itself gets the network's own response, untouched",
    online.url,
    `${ORIGIN}/?k=SECRETKEY`
  )
  network = () => Promise.reject(new TypeError('Failed to fetch'))
  const offline = await fire('GET', `${ORIGIN}/`, 'navigate')!
  check('offline, the kept shell paints (Connect, or "can\'t reach")', await offline.text(), '<p>new shell</p>')
  check(
    'with its status and content type, and still no URL',
    [offline.status, offline.headers.get('content-type'), offline.url],
    [200, 'text/html; charset=utf-8', '']
  )
  store.clear()
  const nothing = await fire('GET', `${ORIGIN}/`, 'navigate')!
  check('offline with nothing kept is a network error, never an invented page', nothing.type, 'error')

  fetched = []
  network = async (url) => fromNetwork(url, new Response('export {}', { headers: { 'content-type': 'text/javascript' } }))
  await (await fire('GET', `${ORIGIN}/assets/index-abc.js`)!).text()
  await settle()
  await (await fire('GET', `${ORIGIN}/assets/index-abc.js`)!).text()
  check('a hashed asset is fetched once, then served from the cache', fetched, [`${ORIGIN}/assets/index-abc.js`])
  check(
    'a file asked for with a query is left to the network, so no stored URL ever carries one',
    [fire('GET', `${ORIGIN}/icon-192.png?k=SECRETKEY`), fire('GET', `${ORIGIN}/assets/index-abc.js?k=SECRETKEY`)].map(
      (p) => p === null
    ),
    [true, true]
  )
  network = async () => html('<!doctype html>')
  await fire('GET', `${ORIGIN}/assets/index-gone.js`)
  await new Promise((r) => setImmediate(r))
  check(
    "HTML answering for an asset (an older server's SPA fallback) is never kept as that asset",
    store.has(`${ORIGIN}/assets/index-gone.js`),
    false
  )

  cacheNames.clear()
  cacheNames.add('stoke-shell-oldbuild').add('stoke-shell-__STOKE_BUILD__').add('someone-elses')
  let activated: Promise<unknown> | null = null
  listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => (activated = p) })
  await activated
  check(
    "activating drops every other build's cache and leaves caches that are not Stoke's",
    [...cacheNames].sort(),
    ['someone-elses', 'stoke-shell-__STOKE_BUILD__']
  )
}

check('a .local suffix is stripped', stripLocalHostnameSuffix('macbookpro.local'), 'macbookpro')
check('so is .localdomain', stripLocalHostnameSuffix('desktop.localdomain'), 'desktop')
check('a bare hostname is untouched', stripLocalHostnameSuffix('macbookpro'), 'macbookpro')
check('only a trailing suffix counts', stripLocalHostnameSuffix('local.example'), 'local.example')

/*
 * Review of PX-3: `PtyManager.submit` ran one timer chain per call, so two
 * submits sent together (the queued flush, a double-tap) typed INTERLEAVED
 * and Claude got one garbled turn ("apple … banana.padding …"). `SubmitQueue`
 * finishes one submit's Enter before the next one's first chunk. Real timers
 * with short gaps, so a regression to parallel chains interleaves here too.
 */
{
  const log: string[] = []
  const q = new SubmitQueue({ chunkGapMs: 3, enterDelayMs: 8, afterEnterMs: 2 })
  const sink = (d: string): boolean => {
    log.push(d)
    return true
  }
  const a = q.push(submitFrames('A'.repeat(SUBMIT_CHUNK * 3), { bracketedPaste: false, claude: true }), sink)
  const b = q.push(submitFrames('B'.repeat(SUBMIT_CHUNK + 5), { bracketedPaste: false, claude: true }), sink)
  const c = q.push(submitFrames('/exit', { bracketedPaste: false, claude: true }), sink)
  await Promise.all([a, b, c])
  const shape = log.map((d) => (d === '\r' ? 'enter' : d[0]))
  check(
    'two submits type strictly in order: A chunks, A enter, B chunks, B enter, then /exit',
    shape,
    ['A', 'A', 'A', 'enter', 'B', 'B', 'enter', '/', 'enter']
  )
  const dead: string[] = []
  let alive = true
  const q2 = new SubmitQueue({ chunkGapMs: 1, enterDelayMs: 1, afterEnterMs: 1 })
  const sink2 = (d: string): boolean => {
    if (!alive) return false
    dead.push(d)
    if (d === '\r') alive = false
    return true
  }
  await Promise.all([
    q2.push(submitFrames('/exit', { bracketedPaste: false, claude: true }), sink2),
    q2.push(submitFrames('after exit', { bracketedPaste: false, claude: true }), sink2)
  ])
  check('a submit queued behind a session that ended writes nothing', dead, ['/exit', '\r'])
  const empty: string[] = []
  await new SubmitQueue({ chunkGapMs: 1, enterDelayMs: 1, afterEnterMs: 1 }).push(
    submitFrames('', { bracketedPaste: false, claude: true }),
    (d) => (empty.push(d), true)
  )
  check('an empty submit writes nothing, not a bare Enter', empty, [])

  /*
   * `enter: false`: the title bar's text shortcuts type and, by default, press
   * nothing (the owner, 2026-10-02). The same typing — chunks, ESC CR newlines
   * — with no Enter written, and the queue still strictly ordered behind it.
   */
  check(
    'enter: false types the same chunks and names no Enter',
    submitFrames('line one\nline two', { bracketedPaste: true, claude: true, enter: false }),
    { chunks: ['line one\u001b\rline two'], enter: '' }
  )
  check(
    'enter left out still presses Enter (the phone and every other caller)',
    submitFrames('hi', { bracketedPaste: false, claude: true }).enter,
    '\r'
  )
  check(
    'another agent’s multi-line text keeps its paste brackets without the Enter',
    submitFrames('a\nb', { bracketedPaste: true, claude: false, enter: false }),
    { chunks: ['\u001b[200~a\nb\u001b[201~'], enter: '' }
  )
  const typed: string[] = []
  const q3 = new SubmitQueue({ chunkGapMs: 1, enterDelayMs: 5, afterEnterMs: 1 })
  const sink3 = (d: string): boolean => {
    typed.push(d)
    return true
  }
  await Promise.all([
    q3.push(submitFrames('T'.repeat(SUBMIT_CHUNK + 3), { bracketedPaste: false, claude: true, enter: false }), sink3),
    q3.push(submitFrames('send me', { bracketedPaste: false, claude: true }), sink3)
  ])
  check(
    'a type-only job writes no \\r, and the send queued behind it still types after it',
    typed.map((d) => (d === '\r' ? 'enter' : d[0])),
    ['T', 'T', 's', 'enter']
  )
}

/*
 * Review of PX-12, "stale tap": the answer route gated on the 1s registry
 * poll alone, so a digit tapped 150ms after the prompt was answered at the
 * desk was written and got 200. A prompt now has an id and a `since`; any
 * input after `since`, or another id, is refused.
 */
{
  const reading = (over: Partial<{ waiting: boolean; waitingFor: string | null; statusUpdatedAt: number | null; readAt: number }>) => ({
    waiting: true,
    waitingFor: 'permission prompt',
    statusUpdatedAt: 1000,
    readAt: 1500,
    ...over
  })
  const a = trackPrompt(null, reading({}), null) as PromptTrack
  check('a new prompt starts at the registry\'s own statusUpdatedAt', [a.since, a.id], [1000, '1000'])
  check('the next reading of the same prompt keeps its id', trackPrompt(a, reading({ readAt: 2500 }), null), a)
  check('not waiting: no prompt', trackPrompt(a, reading({ waiting: false }), null), null)
  check('an untouched prompt with its own id is answerable', answerVerdict(a, a.id, 900), 'ok')
  check('the desk answered it (input after since): refused', answerVerdict(a, a.id, 1150), 'stale')
  check('the phone\'s own first answer makes a double tap stale', answerVerdict(a, a.id, 1000), 'stale')
  check('another prompt\'s id: refused', answerVerdict(a, '999', null), 'stale')
  check('no id at all: refused', answerVerdict(a, undefined, null), 'stale')
  check('no prompt: not waiting', answerVerdict(null, a.id, null), 'not waiting')
  const b = trackPrompt(a, reading({ statusUpdatedAt: 1800, readAt: 2500 }), 1150) as PromptTrack
  check('prompt B (new statusUpdatedAt) gets a new id', b.id !== a.id && b.since === 1800, true)
  check('and B is answerable although A had input', answerVerdict(b, b.id, 1150), 'ok')
  const w = trackPrompt(a, reading({ waitingFor: 'something else' }), null) as PromptTrack
  check('a different waitingFor is a different prompt, never the same id', w.id !== a.id, true)
  check(
    'input, then a reading taken too soon after it: the prompt stays unconfirmed',
    trackPrompt(a, reading({ readAt: 1150 + PROMPT_SETTLE_MS - 1 }), 1150),
    a
  )
  const r = trackPrompt(a, reading({ readAt: 1150 + PROMPT_SETTLE_MS }), 1150) as PromptTrack
  check('a reading well after the input that STILL says waiting re-confirms it under a new id', [r.id !== a.id, r.since], [true, 1650])
  check('so an arrow key at the desk does not lock the phone out for good', answerVerdict(r, r.id, 1150), 'ok')
  check('and the old id is refused', answerVerdict(r, a.id, 1150), 'stale')
  check('no statusUpdatedAt: the reading time stands in', trackPrompt(null, reading({ statusUpdatedAt: null }), null)?.since, 1500)
}

check('a focus report is not typing', isTerminalReport('\u001b[I'), true)
check('nor a colour-scheme report (gotcha 42)', isTerminalReport('\u001b[?997;1n'), true)
check('a digit is typing', isTerminalReport('2'), false)

/*
 * Review of PX-8: the busy-port error says "pick a different port", and a
 * FAILED server was never restarted when the port changed.
 */
{
  const base = { enabled: true, port: 7921, bindLan: false, bindTailscale: false, requireAccessHeader: false, hostname: '', token: 't' }
  const moved = { ...base, port: 7922 }
  check('a running server restarts when the port moves', shouldRestartRemote(base, moved, { running: true, error: null }), true)
  check('a FAILED server with Phone access on is retried', shouldRestartRemote(base, moved, { running: false, error: 'Port 7921 is already in use' }), true)
  check('one the user turned off stays off', shouldRestartRemote(base, { ...moved, enabled: false }, { running: false, error: 'busy' }), false)
  check('an off server with no error is not started by a port edit', shouldRestartRemote(base, moved, { running: false, error: null }), false)
  check('nothing bound moved: no restart', shouldRestartRemote(base, { ...base }, { running: true, error: null }), false)
  check('no server object yet: nothing to restart', shouldRestartRemote(base, moved, null), false)
}

console.log('\nthe connect link advertises the RUNNING server token, never a drifted settings one')
{
  // The bug the user hit on Windows: settings held a token the running server
  // was not validating against, so its own QR got "This link's key isn't current".
  check('a running token wins over a drifted settings token', advertisedRemoteToken('server-key', 'settings-key'), 'server-key')
  check('with the server off, the settings token is the preview', advertisedRemoteToken(null, 'settings-key'), 'settings-key')
  check('an empty running token falls back rather than advertising a blank key', advertisedRemoteToken('', 'settings-key'), 'settings-key')
  check('when they already agree the answer is that token', advertisedRemoteToken('same', 'same'), 'same')
}

// Review of PX-14: /?k=<anything> used to set the cookie with no check.
check('a wrong ?k is never stored as the cookie', mayStoreKeyCookie('WRONGKEY', { ok: false, refused: 'key' }), false)
check('the right one is', mayStoreKeyCookie('RIGHTKEY', { ok: true }), true)
check('no ?k: nothing to store', mayStoreKeyCookie(null, { ok: true }), false)
check('an empty ?k: nothing to store', mayStoreKeyCookie('', { ok: true }), false)
/*
 * Gotcha 124, review: an Access refusal withheld the cookie too, so the phone's
 * next /api call carried no key, got 401, and said "This link's key isn't
 * current" about a key that had just matched.
 */
check(
  'the right key whose Access token this machine refused IS stored',
  mayStoreKeyCookie('RIGHTKEY', { ok: false, refused: 'access', reason: 'no-keys' }),
  true
)

console.log('\nan Access refusal is never told to the phone as a key problem (gotcha 124)')
{
  const REASONS: AccessRefusal[] = [
    'missing',
    'malformed',
    'alg',
    'no-keys',
    'unknown-kid',
    'signature',
    'iss',
    'aud',
    'expired',
    'not-yet-valid',
    'type'
  ]
  check('an authorised request is not refused', [remoteRefusal({ ok: true }), refusalStatusLine({ ok: true })], [null, null])
  const byKey = remoteRefusal({ ok: false, refused: 'key' })
  check(
    'a missing or wrong key is 401 with the old plain-text body (the phone shows Connect)',
    [byKey?.status, byKey?.contentType, byKey?.body],
    [401, 'text/plain; charset=utf-8', 'Unauthorized. Open the link from Stoke, which carries the key.']
  )
  check("the key's socket refusal is 401 too", refusalStatusLine({ ok: false, refused: 'key' }), 'HTTP/1.1 401 Unauthorized')
  check("a 401 is never read as an Access refusal", accessRefusalMessage(byKey?.status, { error: 'x', refused: 'access' }), null)

  // What the phone must NEVER say about a key that matched.
  const keyStory = /replaced|not accepted|isn.t current|scan|copy the link/i
  for (const reason of REASONS) {
    const r = remoteRefusal({ ok: false, refused: 'access', reason })
    let body: unknown = null
    try {
      body = JSON.parse(r?.body ?? '')
    } catch {
      /* judged below */
    }
    const text = accessRefusalMessage(r?.status, body)
    check(
      `Access '${reason}': 403, JSON, and the phone reads back the sentence it was sent`,
      [r?.status, r?.contentType, text !== null && text === accessRefusalForPhone(reason)],
      [403, 'application/json; charset=utf-8', true]
    )
    check(`  and that sentence tells no key story`, keyStory.test(text ?? ''), false)
    check(
      `  and its socket is refused 403, not 401`,
      refusalStatusLine({ ok: false, refused: 'access', reason }),
      'HTTP/1.1 403 Forbidden'
    )
  }
  // The three causes the review named each get their own sentence, naming the machine's side.
  check('a JWKS outage says the keys could not be fetched', /signing keys/.test(accessRefusalForPhone('no-keys')), true)
  check('a stale AUD points at Look it up', /Look it up/.test(accessRefusalForPhone('aud')), true)
  check('clock skew names the clock, both ways', [/clock/.test(accessRefusalForPhone('expired')), /clock/.test(accessRefusalForPhone('not-yet-valid'))], [true, true])
  check('a request that skipped Access says so', /did not/.test(accessRefusalForPhone('missing')), true)
  check('those four are different sentences', new Set(['no-keys', 'aud', 'expired', 'missing'].map((r) => accessRefusalForPhone(r as AccessRefusal))).size, 4)
  // Every OTHER 403 keeps its own meaning: bypass mode is refused with an error and no `refused`.
  check('a bypass-mode 403 is not an Access refusal', accessRefusalMessage(403, { error: 'bypassPermissions is not allowed from the phone' }), null)
  check('nor is a 403 with no body', accessRefusalMessage(403, null), null)
  check('nor an Access-shaped body with an empty sentence', accessRefusalMessage(403, { refused: 'access', error: '' }), null)
}

// Gotcha 92: "Resume conversation" must never quietly become a new one.
{
  const id = '98de4ade-5c86-433a-ad9c-0491efdfbde3'
  check('a Claude resume of an id with no transcript is refused, 404, before anything spawns', (() => {
    const v = resumeVerdict({ resume: true, sessionId: id, livePty: null, hasTranscript: false })
    return v.ok ? 'started' : v.status
  })(), 404)
  check('one with a transcript starts', resumeVerdict({ resume: true, sessionId: id, livePty: null, hasTranscript: true }).ok, true)
  check('one already running in a pty is the 409 that opens it instead', (() => {
    const v = resumeVerdict({ resume: true, sessionId: id, livePty: 'pty-1', hasTranscript: true })
    return v.ok ? 'started' : [v.status, v.ptyId]
  })(), [409, 'pty-1'])
  check('resume naming no valid id is a 400, not a spawn with --resume and nothing after it', (() => {
    const v = resumeVerdict({ resume: true, sessionId: null, livePty: null, hasTranscript: null })
    return v.ok ? 'started' : v.status
  })(), 400)
  check('an agent whose transcripts Stoke cannot look up is not checked', resumeVerdict({ resume: true, sessionId: id, livePty: null, hasTranscript: null }).ok, true)
  check('a new session (no resume) is never refused on transcripts', resumeVerdict({ resume: false, sessionId: id, livePty: null, hasTranscript: false }).ok, true)
}

/*
 * The phone's /api/transcribe answers 503 for "no speech server is set" and
 * 502 for "one is set and failed", and it now takes that from the result of
 * the call itself (`unset`) rather than from a copy of the address captured
 * when the server started — the copy is what kept the phone on an old address
 * until Phone access was turned off and on. What decides both is stt.ts, run
 * here against fake sidecars on loopback port 0: hermetic, nothing shared, all
 * closed before the tally.
 */
console.log('\nthe speech server, per call')
{
  const sidecar = (text: string): Promise<{ server: Server; url: string; bodies: number[] }> =>
    new Promise((resolve) => {
      const bodies: number[] = []
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          bodies.push(Buffer.concat(chunks).length)
          if (req.url !== '/transcribe' || req.method !== 'POST') {
            res.writeHead(404).end()
            return
          }
          if (text === '!500') {
            res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"model fell over"}')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: ` ${text} ` }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server, url: `http://127.0.0.1:${port}`, bodies })
      })
    })
  const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()))
  const wav = new Uint8Array(64).fill(7)
  // The sidecar provider, as `sttConfigOf` builds it from `voice` per call.
  const side = (sttUrl: string) => ({ provider: 'sidecar' as const, model: '', baseUrl: '', sttUrl, key: '' })

  const a = await sidecar('from A')
  const b = await sidecar('from B')
  const broken = await sidecar('!500')
  const gone = await sidecar('never')
  await close(gone.server)

  const none = await transcribe(side(''), wav)
  check(
    'no address is `unset`, the 503 case, and names where to add one',
    none.ok ? 'ok' : [none.unset, /Settings → Voice/.test(none.error)],
    [true, true]
  )
  const blank = await transcribe(side('   '), wav)
  check('nor is whitespace an address', blank.ok ? 'ok' : blank.unset, true)
  check('the address is the argument, per call: A', await transcribe(side(a.url), wav), { ok: true, text: 'from A' })
  check('then B, with nothing restarted in between', await transcribe(side(`${b.url}/`), wav), { ok: true, text: 'from B' })
  check('each sidecar got the clip intact, once', [a.bodies, b.bodies], [[64], [64]])
  const refused = await transcribe(side(gone.url), wav)
  check(
    'a refused connection is a failure but NOT unset — the 502 case — and says it is not the microphone',
    refused.ok ? 'ok' : [refused.unset ?? null, /not the microphone/.test(refused.error), refused.error.includes(gone.url)],
    [null, true, true]
  )
  const failed = await transcribe(side(broken.url), wav)
  check(
    "an upstream 500 passes the sidecar's own words through, and is not unset",
    failed.ok ? 'ok' : [failed.unset ?? null, failed.error],
    [null, 'Speech server: 500 {"error":"model fell over"}']
  )
  check('an empty clip is refused before any request', await transcribe(side(a.url), new Uint8Array(0)), {
    ok: false,
    error: 'Nothing was recorded.'
  })
  check('and sent nothing', a.bodies.length, 1)

  await Promise.all([close(a.server), close(b.server), close(broken.server)])
}

console.log("\n/api/host's defaults (phone contract point 2)")
{
  const d = { permissionMode: 'acceptEdits', model: 'opus', effort: 'high' } as const
  check(
    'the three contract fields are unchanged, and cli is ADDED beside them',
    phoneHostDefaults(d, 'claude', ['claude', 'codex']),
    { permissionMode: 'acceptEdits', model: 'opus', effort: 'high', cli: 'claude' }
  )
  check(
    'bypass is still never offered to the phone',
    phoneHostDefaults({ ...d, permissionMode: 'bypassPermissions' }, 'claude', ['claude']).permissionMode,
    'default'
  )
  check("the desktop's default agent, when the phone is offered it", phoneHostDefaults(d, 'codex', ['claude', 'codex']).cli, 'codex')
  check(
    'a default the phone is NOT offered (uninstalled, unticked) falls back as Start does: Claude Code',
    phoneHostDefaults(d, 'grok', ['claude', 'codex']).cli,
    'claude'
  )
  check('with no Claude on offer, the first agent that is', phoneHostDefaults(d, 'grok', ['codex', 'opencode']).cli, 'codex')
  check('an agent list carrying junk ids cannot become the default', phoneHostDefaults(d, 'grok', ['bash', 'codex']).cli, 'codex')
}

/*
 * What each agent takes (`/api/host` `choices`, `POST /api/sessions`'s
 * `phoneLaunchVerdict`). The phone drew Claude's modes, models and efforts for
 * every start, and hid them for any other agent without saying what it would
 * run; the server accepted any model string for Claude (straight to argv) and
 * any mode for Codex (dropped silently). Both halves are held here.
 */
console.log("\n/api/host's choices per agent, and the start held to them (phone contract points 2, 8)")
{
  const home = '/Users/v/.stoke/accounts'
  const facts: PhoneLaunchFacts = {
    endpoints: {
      codex: { mode: 'default', model: 'gpt-6.1-sol', baseUrl: '', apiKey: '' },
      grok: { mode: 'openrouter', model: 'x-ai/grok-5', baseUrl: '', apiKey: '' }
    },
    accounts: {
      'codex-work': { id: 'codex-work', cli: 'codex', label: 'Work', kind: 'login', home: `${home}/codex-work`, apiKey: '' },
      'grok-spare': { id: 'grok-spare', cli: 'grok', label: 'Spare', kind: 'key', apiKey: '', home: '' },
      'claude-2': { id: 'claude-2', cli: 'claude', label: 'Second', kind: 'login', home: `${home}/claude-2`, apiKey: '' }
    },
    defaultAccount: { codex: 'codex-work' },
    defaultModel: 'claude-opus-5[1m]'
  }
  const all = phoneAgentChoices(['claude', 'codex', 'grok', 'aider', 'bash'], facts)
  check('keyed by every offered agent this build knows, junk ids skipped', Object.keys(all), ['claude', 'codex', 'grok', 'aider'])
  check('Claude Code is always there, even when the offer names no Claude', Object.keys(phoneAgentChoices(['codex'], facts)), ['claude', 'codex'])
  const claude = all.claude
  check("Claude's modes: the four the phone may offer, never bypass", claude.modes.map((m) => m.id), ['default', 'plan', 'acceptEdits', 'auto'])
  check(
    "Claude's models: the launcher's alias list, 1M variants included, plus the desktop's own default model when it is no alias",
    claude.models.map((m) => m.id),
    ['', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'fable[1m]', 'claude-opus-5[1m]']
  )
  check("…and they are Claude's to choose", claude.modelFixed, false)
  check("Claude's efforts", claude.efforts.map((e) => e.id), ['default', 'low', 'medium', 'high', 'xhigh', 'max'])
  check('Claude with a second account: Default first, then it', claude.accounts.map((a) => a.id), ['default', 'claude-2'])
  const codex = all.codex
  check(
    "Codex: no permission mode, no effort (CLI_CAPS says it takes neither)",
    [codex.modes.length, codex.efforts.length, CLI_CAPS.codex.launchFlags.permissionMode, CLI_CAPS.codex.launchFlags.effort],
    [0, 0, false, false]
  )
  check("Codex: the one model its launch runs — its Default model — and fixed", [codex.models, codex.modelFixed], [[{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }], true])
  check("Codex's account picker: Default and Work, and a start naming none is Work (its default account)", [codex.accounts.map((a) => a.id), codex.account], [['default', 'codex-work'], 'codex-work'])
  check("Grok on OpenRouter: the endpoint's model", all.grok.models[0].id, 'x-ai/grok-5')
  check(
    'a key account beside an endpoint that brings its own key is listed with its reason, never silently offered',
    all.grok.accounts.map((a) => [a.id, typeof a.problem === 'string']),
    [['default', false], ['grok-spare', true]]
  )
  check('an agent with no model flag and no endpoint: its own choice, said so', all.aider.models, [{ id: '', label: 'Chosen by Aider' }])
  check('with no accounts there is no picker', all.aider.accounts.map((a) => a.id), ['default'])
  check('only ids, labels, hints, models and reasons leave: no home, no key', JSON.stringify(all).includes(home) || JSON.stringify(all).includes('apiKey'), false)

  const verdict = (body: Record<string, unknown> | null, c: PhoneAgentChoices, label = 'Codex CLI') => {
    const v = phoneLaunchVerdict(body, c, label)
    return v.ok ? [v.permissionMode, v.model, v.effort, v.accountId ?? null] : [v.status, v.error]
  }
  check('Claude: nothing asked is the defaults', verdict(null, claude, 'Claude Code'), ['default', '', 'default', null])
  check('Claude: a listed mode, model and effort pass as asked', verdict({ permissionMode: 'plan', model: 'opus[1m]', effort: 'xhigh' }, claude), ['plan', 'opus[1m]', 'xhigh', null])
  check("Claude: the desktop's own default model passes", verdict({ model: 'claude-opus-5[1m]' }, claude)[1], 'claude-opus-5[1m]')
  check('Claude: a model that is no offered alias is refused (it went to argv as it came)', verdict({ model: 'opus --dangerously-skip-permissions' }, claude)[0], 400)
  check('Claude: an effort off the list is refused', verdict({ effort: 'ultra' }, claude)[0], 400)
  check('Claude: a mode off the list is refused', verdict({ permissionMode: 'dontAsk' }, claude)[0], 400)
  check('Claude: a non-string value is refused', verdict({ model: 7 }, claude)[0], 400)
  check('Codex: nothing asked runs its own model on its default account (main resolves it)', verdict({}, codex), ['default', '', 'default', null])
  check("Codex: its own model named back is fine, and passes nothing (the launch reads settings)", verdict({ model: 'gpt-6.1-sol' }, codex), ['default', '', 'default', null])
  check(
    'Codex: a permission mode is refused, with who takes none',
    verdict({ permissionMode: 'plan' }, codex),
    [400, 'Codex CLI takes no permission mode from Stoke.']
  )
  check('Codex: `default` as the mode (what an older phone sent for Claude) is not a request', verdict({ permissionMode: 'default', effort: 'default' }, codex)[0], 'default')
  check('Codex: an effort is refused', verdict({ effort: 'high' }, codex)[0], 400)
  check('Codex: another model is refused, naming the one it runs', verdict({ model: 'gpt-5' }, codex), [400, 'Codex CLI runs gpt-6.1-sol, set in Stoke’s Settings › Agents; the phone cannot change it.'])
  check('Codex: its own account and Default pass', [verdict({ accountId: 'codex-work' }, codex)[3], verdict({ accountId: 'default' }, codex)[3]], ['codex-work', 'default'])
  check("Codex: another agent's account is refused", verdict({ accountId: 'claude-2' }, codex), [400, 'That account is not one of Codex CLI’s.'])
  check('an account id that is junk is refused, not shape-checked and dropped', verdict({ accountId: '../../x' }, codex)[0], 400)
  check(
    "Grok: its key account with no key — or beside OpenRouter — is a 400 with that account's own sentence",
    verdict({ accountId: 'grok-spare' }, all.grok, 'Grok Build')[0],
    400
  )
  const spareDefault = agentChoicesFor('grok', { ...facts, defaultAccount: { grok: 'grok-spare' } })
  check('and a start naming none, whose default account cannot start, is refused the same way', verdict({}, spareDefault, 'Grok Build')[0], 400)
  const host = hostChoices()
  check("a remote machine takes nothing the phone could pick (gotcha 19)", [host.modes.length, host.efforts.length, host.modelFixed, host.accounts.map((a) => a.id)], [0, 0, true, ['default']])
  check('a remote start with a mode is refused', verdict({ permissionMode: 'plan' }, host, 'A remote machine')[0], 400)
  check('a remote start with nothing extra passes', verdict({}, host, 'A remote machine'), ['default', '', 'default', null])
}

/*
 * Cloudflare Access, verified (gotcha 124). The server used to pass any request
 * carrying `Cf-Access-Jwt-Assertion` — or the unsigned email header — with any
 * value at all. Everything below runs against keypairs generated here and a
 * JWKS served by a fake fetch, on a fake clock: no network, no Cloudflare.
 */
console.log('\nCloudflare Access tokens are verified, not just present (gotcha 124)')
{
  const TEAM = 'stoke-verify.cloudflareaccess.com'
  const AUD = 'd'.repeat(8) + '0123456789abcdef'.repeat(3) + '9'.repeat(8)
  const policy = { teamDomain: TEAM, aud: AUD }
  const CERTS = accessCertsUrl(TEAM)
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const mint = (key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string => {
    const input = `${b64(header)}.${b64(payload)}`
    return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`
  }
  const pairA = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pairB = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = (pub: KeyObject, kid: string): Record<string, unknown> => ({
    ...(pub.export({ format: 'jwk' }) as Record<string, unknown>),
    kid,
    alg: 'RS256',
    use: 'sig'
  })

  let clock = 1_900_000_000_000
  const now = (): number => clock
  const nowS = (): number => Math.floor(clock / 1000)
  let published: unknown = { keys: [jwk(pairA.publicKey, 'kid-a')] }
  let down = false
  let asked: string[] = []
  const fakeFetch = async (url: string): Promise<Response> => {
    asked.push(url)
    if (down) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') })
    if (url !== CERTS) return new Response('not here', { status: 404 })
    return new Response(JSON.stringify(published), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=14400, must-revalidate' }
    })
  }
  const keySet = (): AccessKeySet => new AccessKeySet({ certsUrl: CERTS, fetch: fakeFetch, now })
  const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    aud: [AUD],
    email: 'phone@example.com',
    exp: nowS() + 600,
    iat: nowS(),
    nbf: nowS(),
    iss: `https://${TEAM}`,
    type: 'app',
    sub: 'user-1',
    ...over
  })
  const hdr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ alg: 'RS256', kid: 'kid-a', typ: 'JWT', ...over })
  const reason = (v: { ok: boolean; reason?: string }): string => (v.ok ? 'ok' : (v.reason ?? '?'))
  const verdictOf = async (token: unknown, keys: AccessKeySet): Promise<string> =>
    reason(await verifyAccessJwt(token, policy, keys, now()))

  const keys = keySet()
  const good = mint(pairA.privateKey, hdr(), claims())
  const v1 = await verifyAccessJwt(good, policy, keys, now())
  check('a token Cloudflare signed for this application passes', [v1.ok, v1.ok && v1.subject], [true, 'phone@example.com'])
  check('and cost exactly one JWKS fetch, from the team in settings', asked, [CERTS])
  check('aud as a bare string passes too', await verdictOf(mint(pairA.privateKey, hdr(), claims({ aud: AUD })), keys), 'ok')
  check('aud as a list that includes ours passes', await verdictOf(mint(pairA.privateKey, hdr(), claims({ aud: ['f'.repeat(64), AUD] })), keys), 'ok')
  check('a second verify is served from the cache', asked.length, 1)

  // Presence was the whole check before; now absence and forgery are both refusals.
  check('no header at all is refused', await verdictOf(undefined, keys), 'missing')
  check('nor is an empty one', await verdictOf('', keys), 'missing')
  check('a header sent twice (Node hands over an array) is not a token', await verdictOf([good, good], keys), 'malformed')
  check('the value verify:security used to forge is refused', await verdictOf('verify@localhost', keys), 'malformed')

  console.log('  claims')
  check('wrong aud is refused', await verdictOf(mint(pairA.privateKey, hdr(), claims({ aud: ['e'.repeat(64)] })), keys), 'aud')
  check('no aud is refused', await verdictOf(mint(pairA.privateKey, hdr(), claims({ aud: undefined })), keys), 'aud')
  check(
    'another team as iss is refused, even signed by our key',
    await verdictOf(mint(pairA.privateKey, hdr(), claims({ iss: 'https://evil.cloudflareaccess.com' })), keys),
    'iss'
  )
  check('an iss without the scheme is refused', await verdictOf(mint(pairA.privateKey, hdr(), claims({ iss: TEAM })), keys), 'iss')
  check('the team-wide org token is not an app token', await verdictOf(mint(pairA.privateKey, hdr(), claims({ type: 'org' })), keys), 'type')
  check(
    'expired by more than the leeway is refused',
    await verdictOf(mint(pairA.privateKey, hdr(), claims({ exp: nowS() - ACCESS_LEEWAY_S - 1 })), keys),
    'expired'
  )
  check(
    'expired by less than the leeway still passes (clock skew)',
    await verdictOf(mint(pairA.privateKey, hdr(), claims({ exp: nowS() - ACCESS_LEEWAY_S + 5 })), keys),
    'ok'
  )
  check('a token with no exp is refused', await verdictOf(mint(pairA.privateKey, hdr(), claims({ exp: undefined })), keys), 'expired')
  check('an exp that is not a number is refused', await verdictOf(mint(pairA.privateKey, hdr(), claims({ exp: String(nowS() + 600) })), keys), 'expired')
  check(
    'nbf in the future by more than the leeway is refused',
    await verdictOf(mint(pairA.privateKey, hdr(), claims({ nbf: nowS() + ACCESS_LEEWAY_S + 5 })), keys),
    'not-yet-valid'
  )
  check('nbf a few seconds ahead passes (clock skew)', await verdictOf(mint(pairA.privateKey, hdr(), claims({ nbf: nowS() + 20 })), keys), 'ok')
  check(
    'iat in the future by more than the leeway is refused',
    await verdictOf(mint(pairA.privateKey, hdr(), claims({ iat: nowS() + ACCESS_LEEWAY_S + 5 })), keys),
    'not-yet-valid'
  )
  {
    // A service token has no nbf and no email (Cloudflare's Application token docs).
    const service = claims({ nbf: undefined, email: undefined, sub: '', common_name: 'ci.access' })
    const v = await verifyAccessJwt(mint(pairA.privateKey, hdr(), service), policy, keys, now())
    check('a service token (no nbf, no email) passes, named by its common_name', [v.ok, v.ok && v.subject], [true, 'ci.access'])
  }

  console.log('  algorithm and signature')
  {
    const [h, p, s] = good.split('.')
    check('a payload edited after signing is refused', await verdictOf(`${h}.${b64(claims({ email: 'someone-else@example.com' }))}.${s}`, keys), 'signature')
    const sig = Buffer.from(s, 'base64url')
    sig[10] ^= 0xff
    check('a flipped signature byte is refused', await verdictOf(`${h}.${p}.${sig.toString('base64url')}`, keys), 'signature')
    check('a truncated signature is refused', await verdictOf(`${h}.${p}.${sig.subarray(0, 128).toString('base64url')}`, keys), 'signature')
    check('alg none is refused before any key is looked up', await verdictOf(`${b64(hdr({ alg: 'none' }))}.${p}.AAAA`, keys), 'alg')
    check('alg none with the signature left off is not even a token', await verdictOf(`${b64(hdr({ alg: 'none' }))}.${p}.`, keys), 'malformed')
    // The classic confusion: an HMAC keyed with the PUBLIC key, which anyone has.
    const pem = pairA.publicKey.export({ format: 'pem', type: 'spki' })
    const hsInput = `${b64(hdr({ alg: 'HS256' }))}.${p}`
    check(
      'HS256 keyed with the public key is refused',
      await verdictOf(`${hsInput}.${createHmac('sha256', pem).update(hsInput).digest('base64url')}`, keys),
      'alg'
    )
    const rs512Input = `${b64(hdr({ alg: 'RS512' }))}.${p}`
    check(
      'RS512, even signed by the real key, is refused: Access signs RS256',
      await verdictOf(`${rs512Input}.${sign('sha512', Buffer.from(rs512Input), pairA.privateKey).toString('base64url')}`, keys),
      'alg'
    )
    check('a critical header extension is refused, not ignored', await verdictOf(mint(pairA.privateKey, hdr({ crit: ['exp'] }), claims()), keys), 'malformed')
    check("an attacker's key claiming the real kid fails the signature", await verdictOf(mint(attacker.privateKey, hdr(), claims()), keys), 'signature')
    check(
      'a jku pointing at the attacker is never followed',
      [await verdictOf(mint(attacker.privateKey, hdr({ jku: 'https://evil.example/jwks' }), claims()), keys), asked.includes('https://evil.example/jwks')],
      ['signature', false]
    )
    check('two parts are not a token', await verdictOf(`${h}.${p}`, keys), 'malformed')
    check('base64url with a stray character is not a token', await verdictOf(`${h}.${p}!.${s}`, keys), 'malformed')
    check('an oversize token is refused before decoding', await verdictOf(`${h}.${'A'.repeat(MAX_ACCESS_TOKEN_CHARS)}.AAAA`, keys), 'malformed')
    check('a header that is JSON but not an object is not a token', await verdictOf(`${b64([1])}.${p}.AAAA`, keys), 'malformed')
    check('decodeAccessJwt reads a real one', decodeAccessJwt(good)?.header.kid, 'kid-a')
  }

  console.log('  key rotation and the refetch budget')
  {
    asked = []
    const signedByB = mint(pairB.privateKey, hdr({ kid: 'kid-b' }), claims())
    check(
      'an unknown kid right after a fetch is refused with no refetch (cooldown)',
      [await verdictOf(mint(attacker.privateKey, hdr({ kid: 'kid-x' }), claims()), keys), asked.length],
      ['unknown-kid', 0]
    )
    clock += KID_COOLDOWN_MS + 1
    check(
      'past the cooldown, an unknown kid refetches exactly once, then is refused',
      [await verdictOf(mint(attacker.privateKey, hdr({ kid: 'kid-y' }), claims()), keys), asked.length],
      ['unknown-kid', 1]
    )
    check(
      'a second unknown kid inside the cooldown costs ZERO fetches',
      [await verdictOf(mint(attacker.privateKey, hdr({ kid: 'kid-z' }), claims()), keys), asked.length],
      ['unknown-kid', 1]
    )
    // Cloudflare rotates: B is published beside A.
    published = { keys: [jwk(pairB.publicKey, 'kid-b'), jwk(pairA.publicKey, 'kid-a')] }
    check('a rotated-in key inside the cooldown is not fetched yet', [await verdictOf(signedByB, keys), asked.length], ['unknown-kid', 1])
    clock += KID_COOLDOWN_MS + 1
    check('after the cooldown the new kid is fetched, and its token passes', [await verdictOf(mint(pairB.privateKey, hdr({ kid: 'kid-b' }), claims()), keys), asked.length], ['ok', 2])
    check('the old key still verifies through its week of overlap', await verdictOf(mint(pairA.privateKey, hdr(), claims()), keys), 'ok')
    published = { keys: [jwk(pairB.publicKey, 'kid-b')] }
    clock += 60 * 60_000 + 1
    // Past max-age: the answer comes from the cache and a refresh runs behind it.
    await verdictOf(mint(pairB.privateKey, hdr({ kid: 'kid-b' }), claims()), keys)
    await new Promise((r) => setTimeout(r, 20))
    check('a key the team withdrew is dropped at the next refresh', await verdictOf(mint(pairA.privateKey, hdr(), claims()), keys), 'unknown-kid')
  }

  console.log('  one fetch at a time, and outages')
  {
    published = { keys: [jwk(pairA.publicKey, 'kid-a')] }
    asked = []
    const cold = keySet()
    const token = mint(pairA.privateKey, hdr(), claims())
    const verdicts = await Promise.all(Array.from({ length: 10 }, () => verifyAccessJwt(token, policy, cold, now())))
    check('ten sockets on a cold cache share ONE fetch', [asked.length, verdicts.every((v) => v.ok)], [1, true])
    // The server's start-time prefetch calls refresh() directly, beside a phone's keyFor.
    asked = []
    const prefetched = keySet()
    await Promise.all([prefetched.refresh(), prefetched.refresh(), verifyAccessJwt(token, policy, prefetched, now())])
    check('a prefetch, a second prefetch and a request at once: still one fetch', [asked.length, prefetched.fetches], [1, 1])

    down = true
    asked = []
    const offline = keySet()
    check('JWKS unreachable on a cold cache: refused as no-keys', await verdictOf(token, offline), 'no-keys')
    check('and the failure names the URL it tried', offline.lastError?.startsWith(`Could not fetch ${CERTS}`), true)
    check('an immediate retry is held back', [await verdictOf(token, offline), asked.length], ['no-keys', 1])
    down = false
    clock += EMPTY_RETRY_MS + 1
    check(
      'seconds later, with the network back, it recovers by itself',
      [await verdictOf(mint(pairA.privateKey, hdr(), claims()), offline), offline.lastError],
      ['ok', null]
    )
    down = true
    clock += 2 * 60 * 60_000
    check('a warm cache survives an outage past its max-age', await verdictOf(mint(pairA.privateKey, hdr(), claims()), offline), 'ok')
    clock += MAX_STALE_MS
    check('but not past the staleness limit: fail closed', await verdictOf(mint(pairA.privateKey, hdr(), claims()), offline), 'no-keys')
    down = false
  }

  console.log('  what a JWKS answer may contain')
  {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const parsed = parseJwks(
      JSON.stringify({
        keys: [
          { ...(ec.publicKey.export({ format: 'jwk' }) as object), kid: 'ec', alg: 'ES256' },
          { ...jwk(pairA.publicKey, 'enc'), use: 'enc' },
          { ...jwk(pairA.publicKey, 'rs512'), alg: 'RS512' },
          jwk(weak.publicKey, 'weak'),
          { kty: 'RSA', kid: 'junk', n: '!!', e: 'AQAB' },
          jwk(pairA.publicKey, 'kid-a')
        ]
      })
    )
    check('only a 2048-bit-or-more RS256 signing key survives', [...parsed.keys()], ['kid-a'])
    let threw = ''
    try {
      parseJwks('{"not":"keys"}')
    } catch (e) {
      threw = (e as Error).message
    }
    check('an answer with no keys list is an error, not an empty set', threw, 'the answer has no keys list')
    published = { keys: [jwk(pairA.publicKey, 'kid-a')], padding: 'x'.repeat(MAX_JWKS_BYTES) }
    const big = keySet()
    await big.refresh()
    check('an oversize answer is refused', [big.size, /over \d+ bytes/.test(big.lastError ?? '')], [0, true])
    published = { keys: [jwk(pairA.publicKey, 'kid-a')] }
    check('max-age is honoured, but never past an hour', keysTtlFrom('public, max-age=14400, must-revalidate'), 60 * 60_000)
    check('nor under five minutes', keysTtlFrom('max-age=1'), 5 * 60_000)
    check('and ten minutes when unsaid', keysTtlFrom(null), 10 * 60_000)
  }

  console.log('  settings: what a team domain and an AUD may be')
  check('a pasted team URL is kept as its bare domain', clampAccessTeamDomain('  https://Team-1.cloudflareaccess.com/ '), 'team-1.cloudflareaccess.com')
  check('a path is refused, not trimmed into something that fetches', clampAccessTeamDomain('evil.com/x?'), '')
  check('a lookalike suffix is refused', clampAccessTeamDomain('a.cloudflareaccess.com.evil.com'), '')
  check('a nested subdomain is refused', clampAccessTeamDomain('a.b.cloudflareaccess.com'), '')
  check('a port is refused', clampAccessTeamDomain('team.cloudflareaccess.com:8443'), '')
  check('plain http is refused', clampAccessTeamDomain('http://team.cloudflareaccess.com'), '')
  check('a number is refused', clampAccessTeamDomain(42), '')
  check('an AUD tag is kept, lowercased', clampAccessAud(` ${AUD.toUpperCase()} `), AUD)
  check('63 hex characters is not one', clampAccessAud(AUD.slice(1)), '')
  check('nor is anything not hex', clampAccessAud('g'.repeat(64)), '')
  check(
    'a policy needs both halves',
    [accessPolicyOf({ accessTeamDomain: TEAM, accessAud: '' }), accessPolicyOf({ accessTeamDomain: '', accessAud: AUD })],
    [null, null]
  )
  check('and with both, names them', accessPolicyOf({ accessTeamDomain: TEAM, accessAud: AUD }), policy)
  check('a hand-edited file is clamped on its way to the policy too', accessPolicyOf({ accessTeamDomain: 'evil.example', accessAud: AUD }), null)

  console.log("  Look it up: the team and AUD off Access's own login redirect")
  {
    const HOST = 'code.example.com'
    const meta = (over: Record<string, unknown> = {}, key: KeyObject = pairA.privateKey, kid = 'kid-a'): string =>
      mint(key, { alg: 'RS256', kid, typ: 'JWT' }, { type: 'meta', aud: AUD, hostname: HOST, iat: nowS(), exp: nowS() + 300, ...over })
    const loginUrl = (m: string, kid = AUD, team = TEAM): string =>
      `https://${team}/cdn-cgi/access/login/${HOST}?kid=${kid}&meta=${m}&redirect_url=%2Fapi%2Fhost`
    check('the measured shape parses', parseAccessRedirect(loginUrl('a.b.c')), { teamDomain: TEAM, aud: AUD, meta: 'a.b.c' })
    check('a host that is not *.cloudflareaccess.com is not Access', parseAccessRedirect(loginUrl('a.b.c', AUD, 'login.evil.example')), null)
    check('a kid that is not 64 hex is not an AUD', parseAccessRedirect(loginUrl('a.b.c', 'abc')), null)
    check('no meta, no answer', parseAccessRedirect(loginUrl('')), null)
    check('another path on the team domain is not the login', parseAccessRedirect(`https://${TEAM}/elsewhere?kid=${AUD}&meta=a.b.c`), null)
    check('nor is plain http', parseAccessRedirect(loginUrl('a.b.c').replace('https:', 'http:')), null)

    let probed: { url: string; init?: RequestInit } | null = null
    const edge = (answer: () => Response) => async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === CERTS) return fakeFetch(url)
      probed = { url, init }
      return answer()
    }
    const redirectTo = (location: string) => (): Response => new Response(null, { status: 302, headers: { location } })

    const found = await discoverAccess(` ${HOST.toUpperCase()} `, { fetch: edge(redirectTo(loginUrl(meta()))), now })
    check('a signed login redirect gives the team and AUD', found, { ok: true, teamDomain: TEAM, aud: AUD })
    const seen = probed as { url: string; init?: RequestInit } | null
    const sent = new Headers(seen?.init?.headers)
    check(
      'asked like a browser, redirect not followed (Managed OAuth answers curl with a 401 instead)',
      [seen?.url, seen?.init?.redirect, sent.get('user-agent')?.startsWith('Mozilla/5.0'), sent.get('accept')?.startsWith('text/html')],
      [`https://${HOST}/api/host`, 'manual', true, true]
    )
    const outcome = async (answer: () => Response): Promise<string> => {
      const r = await discoverAccess(HOST, { fetch: edge(answer), now })
      return r.ok ? 'saved' : 'refused'
    }
    check('meta naming another hostname is refused', await outcome(redirectTo(loginUrl(meta({ hostname: 'other.example.com' })))), 'refused')
    check('meta whose aud is not the kid is refused', await outcome(redirectTo(loginUrl(meta({ aud: 'f'.repeat(64) })))), 'refused')
    check('an expired meta is refused', await outcome(redirectTo(loginUrl(meta({ exp: nowS() - 3600 })))), 'refused')
    check('a meta of another type is refused', await outcome(redirectTo(loginUrl(meta({ type: 'app' })))), 'refused')
    check("a meta signed by someone else's key under the team's kid is refused", await outcome(redirectTo(loginUrl(meta({}, attacker.privateKey)))), 'refused')
    check('a meta under a kid the team does not publish is refused', await outcome(redirectTo(loginUrl(meta({}, attacker.privateKey, 'kid-q')))), 'refused')
    const plain = await discoverAccess(HOST, { fetch: edge(() => new Response('{}', { status: 200 })), now })
    check('a hostname that answers without a sign-in has nothing to look up', [plain.ok, !plain.ok && /without a Cloudflare Access sign-in/.test(plain.error)], [false, true])
    const oauth = await discoverAccess(HOST, {
      fetch: edge(
        () =>
          new Response('', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="OAuth", resource_metadata="https://code.example.com/.well-known/cloudflare-access-protected-resource/"' }
          })
      ),
      now
    })
    check("Access's OAuth 401 says so, and points at the paste fields", [oauth.ok, !oauth.ok && /OAuth sign-in/.test(oauth.error)], [false, true])
    check('a redirect somewhere else is not Access', await outcome(redirectTo('https://example.com/login')), 'refused')
    const unreachable = await discoverAccess(HOST, {
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      now
    })
    check('an unreachable hostname is a reason, not a throw', [unreachable.ok, !unreachable.ok && unreachable.error.startsWith('Could not reach')], [false, true])
    const never = async (): Promise<Response> => {
      throw new Error('fetched')
    }
    check('no hostname: nothing is fetched', await discoverAccess('  ', { fetch: never, now }), { ok: false, error: 'Set the public hostname first.' })
    check('a URL is not a hostname', (await discoverAccess('https://x.example.com/a', { fetch: never, now })).ok, false)
  }

  console.log('  the setup check sees Access with Managed OAuth')
  check(
    "a 401 naming Access's protected-resource metadata is Access, not Stoke",
    classifyHostname(401, null, '', 'Bearer realm="OAuth", resource_metadata="https://h/.well-known/cloudflare-access-protected-resource/"'),
    'access'
  )
  check('a plain 401 is still our own server asking for the key', classifyHostname(401, null, '', null), 'ok')

  console.log('  a policy change restarts a running server, dropping every socket')
  {
    const base = {
      enabled: true,
      port: 7921,
      bindLan: false,
      bindTailscale: false,
      requireAccessHeader: true,
      accessTeamDomain: TEAM,
      accessAud: AUD,
      hostname: 'h',
      token: 't'
    }
    check('a new AUD restarts it', shouldRestartRemote(base, { ...base, accessAud: 'f'.repeat(64) }, { running: true, error: null }), true)
    check('a new team restarts it', shouldRestartRemote(base, { ...base, accessTeamDomain: 'other.cloudflareaccess.com' }, { running: true, error: null }), true)
    check('equal values after a hydrate do not', shouldRestartRemote(base, { ...base, accessAud: `${AUD}` }, { running: true, error: null }), false)
  }
}

/*
 * Phone contract points 12 and 13: a phone may browse and create folders only
 * under a project root, the default folder, or the folder holding a known
 * project. The bearer key is the whole defence, so every way out is a case.
 */
console.log('\nwhere a phone may browse (remoteFolderVerdict)')
{
  const mac = pathRulesFor('darwin')
  const linux = pathRulesFor('linux')
  const win = pathRulesFor('win32')
  const root: FolderBase[] = [{ path: '/Users/v/dev/Stoke', kind: 'root' }]
  const verdict = (requested: string, real: string, bases = root, rules = mac) =>
    remoteFolderVerdict({ requested, real, bases }, rules)
  check('inside a root', verdict('/Users/v/dev/Stoke/src', '/Users/v/dev/Stoke/src').ok, true)
  check('the root itself', verdict('/Users/v/dev/Stoke', '/Users/v/dev/Stoke').ok, true)
  check(
    'a sibling that only shares the prefix (…/Stoke-old) is outside',
    verdict('/Users/v/dev/Stoke-old', '/Users/v/dev/Stoke-old'),
    { ok: false, reason: 'outside' }
  )
  check(
    'a symlink inside the root that points out of it is judged where it leads: outside',
    verdict('/Users/v/dev/Stoke/escape', '/etc'),
    { ok: false, reason: 'outside' }
  )
  check(
    'and one pointing in from outside is judged where it leads: inside',
    verdict('/Users/v/elsewhere/link', '/Users/v/dev/Stoke/src').ok,
    true
  )
  check('a .. segment is refused before anything resolves it', verdict('/Users/v/dev/Stoke/../../etc', '/Users/v/etc'), {
    ok: false,
    reason: 'malformed'
  })
  check('so is a . segment', verdict('/Users/v/dev/Stoke/./src', '/Users/v/dev/Stoke/src').ok, false)
  check('a relative path is refused', verdict('dev/Stoke', '/Users/v/dev/Stoke').ok, false)
  check('a NUL is refused', verdict('/Users/v/dev/Stoke\0/x', '/Users/v/dev/Stoke/x').ok, false)
  check('a non-string (a crafted query) is refused, not thrown on', remoteFolderVerdict({ requested: 7, real: '', bases: root }, mac).ok, false)
  check('nothing is allowed when there are no places', verdict('/Users/v/dev/Stoke', '/Users/v/dev/Stoke', []).ok, false)
  check(
    'case folds on macOS, where the disk does',
    verdict('/users/v/dev/stoke/src', '/users/v/dev/stoke/src').ok,
    true
  )
  check(
    'and never on Linux, where /home/v/Dev and /home/v/dev are two folders',
    remoteFolderVerdict(
      { requested: '/home/v/dev/x', real: '/home/v/dev/x', bases: [{ path: '/home/v/Dev', kind: 'root' }] },
      linux
    ).ok,
    false
  )
  check(
    'Windows: case folds, either separator',
    remoteFolderVerdict(
      { requested: 'c:/users/v/dev/app', real: 'c:\\users\\v\\dev\\app', bases: [{ path: 'C:\\Users\\v\\dev', kind: 'root' }] },
      win
    ).ok,
    true
  )
  check(
    'a drive root is out of bounds (403), not malformed (400) — the same answer `/` gets',
    [
      remoteFolderVerdict({ requested: 'C:\\', real: 'C:\\', bases: [{ path: 'C:\\Users\\v\\dev', kind: 'root' }] }, win),
      verdict('/', '/')
    ],
    [
      { ok: false, reason: 'outside' },
      { ok: false, reason: 'outside' }
    ]
  )
  check(
    'a too-shallow place handed straight to the verdict still counts for nothing',
    verdict('/Users/other/secret', '/Users/other/secret', [{ path: '/Users', kind: 'parent' }]).ok,
    false
  )
  check('isPlainFolderPath: Windows drive and UNC paths are absolute there', [
    isPlainFolderPath('C:\\x\\y', win),
    isPlainFolderPath('\\\\server\\share\\x', win),
    isPlainFolderPath('/x/y', win),
    isPlainFolderPath('/x/y', mac)
  ], [true, true, false, true])
  check('folderDepth does not count a drive letter', [folderDepth('/'), folderDepth('/Users'), folderDepth('C:\\Users\\v'), folderDepth('/Users/v/')], [0, 1, 2, 2])
}

console.log('\nthe places themselves (remoteFolderBases)')
{
  const mac = pathRulesFor('darwin')
  const bases = (roots: string[], defaultCwd: string, projects: string[], rules = mac) =>
    remoteFolderBases({ roots, defaultCwd, projects }, rules).map((b) => [b.kind, b.path])
  check(
    'roots, the default folder, and the folder holding each project, in that order',
    bases(['/Users/v/roots'], '/Users/v/default', ['/Users/v/dev/a']),
    [
      ['root', '/Users/v/roots'],
      ['default', '/Users/v/default'],
      ['parent', '/Users/v/dev']
    ]
  )
  check(
    'a project in the home folder does NOT make /Users — every account — a place',
    bases([], '', ['/Users/v']),
    []
  )
  check('nor does a project at the root make the whole disk one', bases([], '', ['/']), [])
  check('nor a root of /, however it got into Settings', bases(['/'], '', []), [])
  check('two projects side by side are one place', bases([], '', ['/Users/v/dev/a', '/Users/v/dev/b']), [['parent', '/Users/v/dev']])
  check(
    'a place inside another is folded into it, and a wider one arriving later takes its slot',
    bases(['/Users/v/dev/personal'], '/Users/v/dev/personal/x', ['/Users/v/dev/stoke']),
    [['parent', '/Users/v/dev']]
  )
  check('a default folder that IS a root is listed once, as the root', bases(['/Users/v/dev'], '/Users/v/dev', []), [['root', '/Users/v/dev']])
  check('an empty default folder is simply absent', bases(['/Users/v/dev'], '', []), [['root', '/Users/v/dev']])
  check(
    'Windows: C:\\Users is too shallow, C:\\Users\\v\\dev is not',
    bases([], '', ['C:\\Users\\v', 'C:\\Users\\v\\dev\\app'], pathRulesFor('win32')),
    [['parent', 'C:\\Users\\v\\dev']]
  )

  /*
   * Review finding on gotcha 121: a phone can make a place a project (Start
   * here on the place's own folder, or a session in the default folder), and
   * every project's parent was a place — so each tap climbed one folder, to
   * the depth floor. A project that is itself a place lends nothing now.
   */
  check('Start here on a root makes it a project, and adds nothing above it', bases(['/Volumes/X/a/b'], '', ['/Volumes/X/a/b']), [
    ['root', '/Volumes/X/a/b']
  ])
  check('nor does the default folder once a session there makes it a project', bases([], '/Users/v/dev', ['/Users/v/dev']), [
    ['default', '/Users/v/dev']
  ])
  check(
    'nor does the folder holding a project, added as one itself',
    bases([], '', ['/private/var/folders/ab/cd/T/job', '/private/var/folders/ab/cd/T']),
    [['parent', '/private/var/folders/ab/cd/T']]
  )
  check(
    'nor the scratch root, which a scratch session makes a place',
    bases([], '', ['/Users/v/Library/Stoke/scratch/2026-09-30', '/Users/v/Library/Stoke/scratch']),
    [['parent', '/Users/v/Library/Stoke/scratch']]
  )
  check(
    'what that costs: a project that gains one inside it stops lending (narrower, never wider)',
    bases([], '', ['/Users/v/dev/foo', '/Users/v/dev/foo/sub']),
    [['parent', '/Users/v/dev/foo']]
  )
  {
    // The climb itself: tap Start here on every place, round after round.
    let projects = ['/Volumes/X/a/b/c/app', '/Users/v/dev/personal/stoke', '/private/var/folders/ab/cd/T/job']
    const roots = ['/Users/v/work/clients/acme']
    const defaultCwd = '/Users/v/dev/personal'
    const start = bases(roots, defaultCwd, projects)
    const seen: string[][][] = []
    for (let round = 0; round < 6; round++) {
      const places = remoteFolderBases({ roots, defaultCwd, projects }, mac)
      projects = [...new Set([...projects, ...places.map((b) => b.path)])]
      seen.push(bases(roots, defaultCwd, projects))
    }
    check('Start here on every place, six rounds: the places never move', seen, Array(6).fill(start))
  }
  {
    /*
     * And for every add a phone can make, in every configuration of a small
     * tree: the folders a phone can add are exactly those inside a place (its
     * own `POST /api/projects` judge), and after the add every place must be
     * inside one that was there before.
     */
    const tree = [
      '/Users/v',
      '/Users/v/dev',
      '/Users/v/dev/a',
      '/Users/v/dev/a/sub',
      '/Users/v/dev/b',
      '/Users/v/work',
      '/Users/v/work/x',
      '/Users/v/work/x/y',
      '/Volumes/X',
      '/Volumes/X/p',
      '/Volumes/X/p/q'
    ]
    let configs = 0
    let adds = 0
    let widened: unknown = null
    for (const roots of [[], ['/Users/v/work/x']]) {
      for (const defaultCwd of ['', '/Users/v/dev', '/Volumes/X/p']) {
        for (let mask = 0; mask < 1 << tree.length; mask++) {
          const projects = tree.filter((_, i) => mask & (1 << i))
          const before = remoteFolderBases({ roots, defaultCwd, projects }, mac)
          configs++
          for (const add of tree) {
            if (projects.includes(add)) continue
            if (!remoteFolderVerdict({ requested: add, real: add, bases: before }, mac).ok) continue
            adds++
            const after = remoteFolderBases({ roots, defaultCwd, projects: [...projects, add] }, mac)
            const wider = after.find((a) => !before.some((b) => isInside(b.path, a.path, mac)))
            if (wider && !widened) widened = { roots, defaultCwd, projects, add, before, after }
          }
        }
      }
    }
    check(`no phone add widens the places (${adds} adds over ${configs} configurations)`, widened, null)
  }
}

/*
 * The same rules against a real disk: a real symlink out of a place, a real
 * sibling prefix, a file, a dot-folder, and more folders than one answer lists.
 * Everything lives under a fresh temp dir and is removed afterwards. The dir is
 * resolved the way the product resolves a place (`realpathFolder` is
 * `fs/promises`' realpath, the native call): macOS's own `$TMPDIR` is a
 * symlink, and GitHub's Windows runner's is the 8.3 `C:\Users\RUNNER~1\…`,
 * which node's JS `realpathSync` keeps as spelled while the native call
 * expands it. Built on the JS answer, every expected path was the short
 * spelling of a place the product had rightly stored long, and the missing
 * folder below went 403: a path that does not exist cannot be resolved, so it
 * is judged as spelled, outside the long place. The phone never sends that
 * spelling (it asks only for paths the server listed, all long), so the
 * product answer is right and the test's spelling was not.
 */
console.log('\nbrowsing a real folder (GET /api/folders)')
{
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'stoke-browse-')))
  try {
    const place = join(tmp, 'projects')
    const outside = join(tmp, 'projects-old')
    mkdirSync(join(place, 'alpha', 'inner'), { recursive: true })
    mkdirSync(join(place, 'Beta'))
    mkdirSync(join(place, '.git'))
    mkdirSync(outside)
    writeFileSync(join(place, 'notes.txt'), 'x')
    symlinkSync(outside, join(place, 'escape'))
    const bases = await resolveFolderBases({ roots: [place], defaultCwd: '', projects: [], platform: process.platform })
    check('the root is the one place', bases.map((b) => b.path), [place])

    const places = await browseRemoteFolder(null, bases, process.platform)
    check('with no path: the places, each with its kind', places.ok ? places.body.folders.map((f) => [f.path, f.kind]) : places, [[place, 'root']])

    const listed = await browseRemoteFolder(place, bases, process.platform)
    check(
      'subfolders only: no file, no dot-folder; a symlinked folder is listed (judged when opened)',
      listed.ok ? listed.body.folders.map((f) => f.name) : listed,
      ['alpha', 'Beta', 'escape']
    )
    check('at the place there is no way up', listed.ok ? [listed.body.base, listed.body.up] : listed, [place, null])
    const inner = await browseRemoteFolder(join(place, 'alpha'), bases, process.platform)
    check('one down, up is the place', inner.ok ? [inner.body.path, inner.body.up, inner.body.folders.map((f) => f.name)] : inner, [
      join(place, 'alpha'),
      place,
      ['inner']
    ])
    const escaped = await browseRemoteFolder(join(place, 'escape'), bases, process.platform)
    check('opening the symlink that leads out: 403', escaped.ok ? 'served' : escaped.status, 403)
    const sibling = await browseRemoteFolder(outside, bases, process.platform)
    check('the sibling that shares the prefix: 403', sibling.ok ? 'served' : sibling.status, 403)
    const missingOutside = await browseRemoteFolder(join(tmp, 'nope', 'nothing'), bases, process.platform)
    check('a missing folder outside: 403 as well, so a probe cannot tell it from one that exists', missingOutside.ok ? 'served' : missingOutside.status, 403)
    const missingInside = await browseRemoteFolder(join(place, 'gone'), bases, process.platform)
    check('a missing folder inside a place: 404', missingInside.ok ? 'served' : missingInside.status, 404)
    const file = await browseRemoteFolder(join(place, 'notes.txt'), bases, process.platform)
    check('a file: 400', file.ok ? 'served' : file.status, 400)
    const traversal = await browseRemoteFolder(`${place}/../projects-old`, bases, process.platform)
    check('a traversal: 400, never resolved', traversal.ok ? 'served' : traversal.status, 400)
    /*
     * A real system folder outside every place. Not `/etc` on Windows: there a
     * path with no drive letter is malformed (`isAbsoluteFor`), a 400 before
     * anything resolves it. Its existence is part of the check, or this would
     * quietly repeat "a missing folder outside" above.
     */
    const system = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc'
    const sys = await browseRemoteFolder(system, bases, process.platform)
    check(`${system}, a real folder outside every place: 403`, [existsSync(system), sys.ok ? 'served' : sys.status], [true, 403])

    const crowd = join(place, 'crowd')
    for (let i = 0; i < 205; i++) mkdirSync(join(crowd, `d${i}`), { recursive: true })
    const capped = await listSubfolders(crowd)
    check('at most 200 in one answer, and it says so', [capped?.folders.length, capped?.truncated], [200, true])
    check('sorted as a person reads numbers (d2 before d10)', capped?.folders.slice(0, 3).map((f) => f.name), ['d0', 'd1', 'd2'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  check('newFolderNameProblem is the server’s own gate too', newFolderNameProblem('../x') !== null, true)
}

/*
 * Web Push (phone contract point 14). When a push fires is a pure edge
 * (`pushFor`); what it says is content-free (`pushPayload`); where it may go is
 * the real push services only (`pushEndpointOk`); and the bytes are RFC 8291's
 * — checked against the RFC's own Appendix A vector, not against ourselves.
 */
console.log('\nWeb Push: when, what, to where, and the bytes (phone contract point 14)')
{
  const P1 = { waitingFor: 'Bash', statusUpdatedAt: 1000 }
  const S = (status: PushState['status'], prompt: PushState['prompt'] = null): PushState => ({ status, prompt })
  check('busy → waiting: needs you', pushFor(S('busy'), S('waiting', P1)), 'needs-you')
  check('idle → waiting: needs you too', pushFor(S('idle'), S('waiting', P1)), 'needs-you')
  check('waiting → waiting, the same prompt: nothing (it fired once)', pushFor(S('waiting', P1), S('waiting', { ...P1 })), null)
  check('waiting → waiting, the registry wrote a new stamp: a NEW prompt, needs you again', pushFor(S('waiting', P1), S('waiting', { ...P1, statusUpdatedAt: 2000 })), 'needs-you')
  check('…or asks for something else', pushFor(S('waiting', P1), S('waiting', { ...P1, waitingFor: 'Edit' })), 'needs-you')
  check('a prompt that only now has an identity is the same prompt', pushFor(S('waiting', null), S('waiting', P1)), null)
  check('exit (ended on its own): finished', pushFor(S('busy'), S('ended')), 'finished')
  check('…from waiting as well', pushFor(S('waiting', P1), S('ended')), 'finished')
  check('ended → ended: once only', pushFor(S('ended'), S('ended')), null)
  check('first sight is a baseline: a start never announces what was already so', [pushFor(null, S('waiting', P1)), pushFor(null, S('ended'))], [null, null])
  check('busy → idle and waiting → busy say nothing', [pushFor(S('busy'), S('idle')), pushFor(S('waiting', P1), S('busy'))], [null, null])
  check('pushStateOf carries a prompt only while waiting', [pushStateOf('busy', null).prompt, pushStateOf('idle', { id: 'x', since: 1, ...P1 }).prompt], [null, null])

  /*
   * Review of the first cut: `pushFor` fired on a new ANSWER id, and
   * `trackPrompt` mints one for the same prompt once input reached the pty
   * and a reading `PROMPT_SETTLE_MS` later still says waiting. So an arrow key
   * in a permission menu, a wheel scroll, or each pause while typing an
   * answer at the desk sent another high-urgency "Needs you". Built here as
   * the server builds them: one `trackPrompt` per registry pass, then
   * `pushStateOf`, with input landing between readings.
   */
  let track: PromptTrack | null = null
  let last: PushState | null = null
  const pass = (status: PushState['status'], r: { waitingFor?: string | null; statusUpdatedAt?: number | null; readAt: number }, lastInputAt: number | null) => {
    track = trackPrompt(
      track,
      { waiting: status === 'waiting', waitingFor: r.waitingFor ?? null, statusUpdatedAt: r.statusUpdatedAt ?? null, readAt: r.readAt },
      lastInputAt
    )
    const next = pushStateOf(status, track)
    const kind = pushFor(last, next)
    last = next
    return { kind, id: track?.id ?? null }
  }
  check('a busy session first seen: the baseline', pass('busy', { readAt: 500 }, null).kind, null)
  const asked = pass('waiting', { ...P1, readAt: 1500 }, null)
  check('its prompt appears: needs you, once', asked.kind, 'needs-you')
  const arrow = pass('waiting', { ...P1, readAt: 1500 + 1000 }, 1600)
  check('an arrow key at the desk, then a reading after the settle: the answer id WAS re-minted', arrow.id !== asked.id, true)
  check('…and the phone is told nothing: the same prompt is on screen', arrow.kind, null)
  const typing = [3000, 4200, 5400].map((at) => pass('waiting', { ...P1, readAt: at + PROMPT_SETTLE_MS + 100 }, at))
  check(
    'typing an answer with pauses: a re-mint per pause, and not one push',
    [new Set([arrow.id, ...typing.map((t) => t.id)]).size, typing.map((t) => t.kind)],
    [4, [null, null, null]]
  )
  check('a scroll (a mouse report is input too) re-mints, still silent', pass('waiting', { ...P1, readAt: 7000 }, 6400).kind, null)
  check('the next prompt, written by the CLI with a new stamp: needs you', pass('waiting', { waitingFor: 'Bash', statusUpdatedAt: 7500, readAt: 8000 }, 6400).kind, 'needs-you')
  check('answered: waiting → busy says nothing', pass('busy', { readAt: 9000 }, 8600).kind, null)
  check('and a prompt after that: needs you again', pass('waiting', { waitingFor: 'Edit', statusUpdatedAt: 9500, readAt: 10_000 }, 8600).kind, 'needs-you')

  const p = pushPayload('needs-you', '  my   project  ', 'pty-1')
  check('the payload: the project name, a status word, the session route — nothing else', p, { title: 'my project', body: 'Needs you', tag: 'stoke-pty-1', url: '#/s/pty-1' })
  check('finished says so', pushPayload('finished', 'app', 'x').body, 'Finished')
  check('a long name is cut, never wrapped', Array.from(pushPayload('finished', 'n'.repeat(200), 'x').title).length, 60)
  check('the test push names no session', pushPayload('test', 'anything', ''), { title: 'Stoke', body: 'Notifications are on.', tag: 'stoke-test', url: '#/' })

  const FCM = 'https://fcm.googleapis.com/fcm/send/abc123'
  check(
    'the real push services pass',
    [FCM, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QK', 'https://wns2-par02p.notify.windows.com/w/?token=x'].map((e) => pushEndpointOk(e, false)),
    [true, true, true, true]
  )
  check(
    'anywhere else is refused: another host, a look-alike, http, a LAN address, credentials, an odd port',
    [
      'https://evil.example/push',
      'https://fcm.googleapis.com.evil.example/x',
      'https://notify.windows.com/x',
      'http://fcm.googleapis.com/x',
      'https://192.168.1.1/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'http://127.0.0.1:9/x',
      'not a url',
      42
    ].map((e) => pushEndpointOk(e, false)),
    [false, false, false, false, false, false, false, false, false, false]
  )
  check('loopback http only where a test build allows it, and only 127.0.0.1', [pushEndpointOk('http://127.0.0.1:9/x', true), pushEndpointOk('http://localhost:9/x', true), pushEndpointOk('http://10.0.0.2:9/x', true)], [true, false, false])

  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const uaAuth = randomBytes(16)
  const good = { endpoint: FCM, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } }
  check('a real PushSubscription.toJSON() passes', pushSubscriptionFrom(good, false).ok, true)
  check('padding is tolerated and dropped', pushSubscriptionFrom({ ...good, keys: { p256dh: `${good.keys.p256dh}=`, auth: `${good.keys.auth}==` } }, false), { ok: true, sub: { endpoint: FCM, ...good.keys } })
  check(
    'a key that is no P-256 point, or an auth secret of the wrong size, is refused',
    [
      pushSubscriptionFrom({ ...good, keys: { ...good.keys, p256dh: good.keys.p256dh.slice(1) } }, false).ok,
      pushSubscriptionFrom({ ...good, keys: { ...good.keys, p256dh: `A${good.keys.p256dh.slice(1)}` } }, false).ok,
      pushSubscriptionFrom({ ...good, keys: { ...good.keys, auth: 'short' } }, false).ok,
      pushSubscriptionFrom({ ...good, endpoint: 'https://evil.example/x' }, false).ok,
      pushSubscriptionFrom(null, false).ok
    ],
    [false, false, false, false, false]
  )

  const sub = (endpoint: string, keyTag = 'aaaaaaaaaaaaaaaa') => ({ endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth, keyTag, addedAt: 1 })
  const list = withPushSubscription([sub(FCM), sub(`${FCM}2`, 'bbbbbbbbbbbbbbbb')], { endpoint: FCM, p256dh: good.keys.p256dh, auth: good.keys.auth }, 'aaaaaaaaaaaaaaaa', 5)
  check('re-subscribing replaces its own record; one made under another phone key is dropped', list.map((s) => [s.endpoint, s.addedAt]), [[FCM, 5]])
  const many = Array.from({ length: 12 }, (_, i) => `${FCM}/${i}`).reduce(
    (acc, e) => withPushSubscription(acc, { endpoint: e, p256dh: good.keys.p256dh, auth: good.keys.auth }, 'aaaaaaaaaaaaaaaa', 1),
    [] as ReturnType<typeof withPushSubscription>
  )
  check('at most eight, the oldest first out', [many.length, many[0].endpoint], [MAX_PUSH_SUBSCRIPTIONS, `${FCM}/4`])
  check(
    'only subscriptions under the key in force are sent to (a replaced key is a phone locked out)',
    livePushSubscriptions([sub(FCM), sub(`${FCM}2`, 'bbbbbbbbbbbbbbbb'), sub('http://127.0.0.1:9/x')], 'aaaaaaaaaaaaaaaa', false).map((s) => s.endpoint),
    [FCM]
  )
  /*
   * Review of the first cut: the phone's sheet said On from the browser's own
   * subscription alone, so a replaced key, an eviction or a drop after 404/410
   * left it On while nothing came. The phone now re-sends its subscription at
   * every start and sheet open (an upsert), and one its push service already
   * refused is answered 410 instead of taken back — named by endpoint AND key.
   */
  const gone1 = pushSubscriptionKey({ endpoint: FCM, p256dh: good.keys.p256dh })
  const fresh = createECDH('prime256v1')
  fresh.generateKeys()
  check(
    'a fresh subscription at a reused endpoint is not the gone one (its key is new)',
    pushSubscriptionKey({ endpoint: FCM, p256dh: fresh.getPublicKey().toString('base64url') }) !== gone1,
    true
  )
  check('re-sending the same one is an upsert, not a second record', withPushSubscription(list, { endpoint: FCM, p256dh: good.keys.p256dh, auth: good.keys.auth }, 'aaaaaaaaaaaaaaaa', 9).map((s) => [s.endpoint, s.addedAt]), [[FCM, 9]])
  check(
    'a phone re-scanned under a new key re-sends and is live again; every record under the old key goes',
    livePushSubscriptions(withPushSubscription([sub(FCM), sub(`${FCM}2`)], { endpoint: FCM, p256dh: good.keys.p256dh, auth: good.keys.auth }, 'cccccccccccccccc', 9), 'cccccccccccccccc', false).map((s) => s.endpoint),
    [FCM]
  )
  const goneList = Array.from({ length: MAX_GONE_PUSH + 5 }, (_, i) => `k${i}`).reduce((acc, k) => rememberGonePush(acc, [k]), [] as string[])
  check('the gone memory keeps the newest, bounded', [goneList.length, goneList[0], goneList.at(-1)], [MAX_GONE_PUSH, 'k5', `k${MAX_GONE_PUSH + 4}`])
  check('refused twice is remembered once, as the newest', rememberGonePush(['a', 'b', 'c'], ['a']), ['b', 'c', 'a'])

  const vapid = generateVapidKeys()
  const hydrated = hydrateRemotePush({
    vapidPublic: vapid.publicKey,
    vapidPrivate: vapid.privateKey,
    subscriptions: [sub(FCM), { ...sub('https://evil.example/x') }, { ...sub(`${FCM}3`), keyTag: 'NOT HEX' }, 'junk'],
    extra: 'dropped'
  })
  check('hydrate: rebuilt from named keys; an endpoint off the services, a bad tag and junk are dropped', [Object.keys(hydrated), hydrated.subscriptions.map((s) => s.endpoint)], [['vapidPublic', 'vapidPrivate', 'subscriptions'], [FCM]])
  check('hydrate: no public key, no subscriptions (they were made to a pair that is gone)', hydrateRemotePush({ vapidPublic: 'nope', subscriptions: [sub(FCM)] }), EMPTY_REMOTE_PUSH)
  check('hydrate: a sealed-away private key stays empty rather than dropping the pair', hydrateRemotePush({ vapidPublic: vapid.publicKey, vapidPrivate: '' }).vapidPublic, vapid.publicKey)
  check('a minted pair is whole; a mismatched or empty one is not', [isVapidPair(vapid), isVapidPair({ ...vapid, privateKey: generateVapidKeys().privateKey }), isVapidPair({ ...vapid, privateKey: '' })], [true, false, false])

  // RFC 8291 Appendix A, byte for byte.
  const b = (s: string): Buffer => Buffer.from(s, 'base64url')
  const rfc = encryptPush(
    b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), privateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') }
  )
  check(
    "encryptPush reproduces RFC 8291's Appendix A message exactly",
    rfc.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  )

  /** The receiver's side, as a phone's browser does it (RFC 8291 §3.4 read backwards). */
  const decrypt = (msg: Buffer, receiver: ECDH, auth: Buffer): string => {
    const salt = msg.subarray(0, 16)
    const idlen = msg.readUInt8(20)
    const asPublic = msg.subarray(21, 21 + idlen)
    const shared = receiver.computeSecret(asPublic)
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), asPublic])
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
    const body = msg.subarray(21 + idlen)
    const d = createDecipheriv('aes-128-gcm', cek, nonce)
    d.setAuthTag(body.subarray(body.length - 16))
    const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
    return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8')
  }
  const round = encryptPush(Buffer.from('{"title":"app"}'), good.keys)
  check('a fresh message decrypts with the subscription’s own private key', decrypt(round, ua, uaAuth), '{"title":"app"}')
  check('and two messages never share a salt or an ephemeral key', round.subarray(0, 86).equals(encryptPush(Buffer.from('x'), good.keys).subarray(0, 86)), false)

  const jwt = vapidJwt(`${FCM}/deep/path?x=1`, vapid, 1_000_000)
  const [h, c, sig] = jwt.split('.')
  const jwk = { kty: 'EC', crv: 'P-256', x: b(vapid.publicKey).subarray(1, 33).toString('base64url'), y: b(vapid.publicKey).subarray(33).toString('base64url') }
  check('the VAPID JWT verifies against the public key (ES256, P1363)', verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b(sig)), true)
  check(
    'for the push service’s ORIGIN, within a day, from an https subject',
    [JSON.parse(b(h).toString()), JSON.parse(b(c).toString())],
    [{ typ: 'JWT', alg: 'ES256' }, { aud: 'https://fcm.googleapis.com', exp: 1_000_000 + 12 * 3600, sub: VAPID_SUBJECT }]
  )

  // A fake push service on loopback: what a send puts on the wire, and what its answers mean.
  const seen: { headers: Record<string, string | string[] | undefined>; body: Buffer }[] = []
  let answer = 201
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(answer)
      res.end()
    })
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  const port = (fake.address() as { port: number }).port
  const record = { endpoint: `http://127.0.0.1:${port}/push/phone-1`, ...good.keys, keyTag: 'aaaaaaaaaaaaaaaa', addedAt: 1 }
  try {
    check('a 201 is sent', await sendPush(record, pushPayload('needs-you', 'app', 'pty-9'), vapid, { urgency: 'high' }), 'sent')
    const got = seen[0]
    check(
      'aes128gcm, a TTL, the urgency, and a vapid Authorization naming the public key',
      [got.headers['content-encoding'], got.headers.ttl, got.headers.urgency, String(got.headers.authorization).endsWith(`, k=${vapid.publicKey}`)],
      ['aes128gcm', '3600', 'high', true]
    )
    check('what the phone decrypts is the content-free payload, and nothing else', JSON.parse(decrypt(got.body, ua, uaAuth)), pushPayload('needs-you', 'app', 'pty-9'))
    answer = 410
    check('410: the phone is gone, forget it', await sendPush(record, pushPayload('finished', 'app', 'x'), vapid), 'gone')
    answer = 404
    check('404: gone as well', await sendPush(record, pushPayload('finished', 'app', 'x'), vapid), 'gone')
    answer = 503
    check('a service error is a failure, and the subscription is kept', await sendPush(record, pushPayload('finished', 'app', 'x'), vapid), 'failed')
    check('nothing listening is a failure, not a throw', await sendPush({ ...record, endpoint: 'http://127.0.0.1:9/x' }, pushPayload('finished', 'app', 'x'), vapid), 'failed')
  } finally {
    await new Promise<void>((r) => fake.close(() => r()))
  }

  // The worker's half: what it shows, and where a tap goes.
  const swSource = readFileSync(new URL('../src/remote/public/sw.js', import.meta.url), 'utf8')
  const listeners = new Map<string, (event: unknown) => void>()
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const messages: unknown[] = []
  const opened: string[] = []
  let windows: { url: string; postMessage: (m: unknown) => void; focus: () => Promise<unknown> }[] = []
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      registration: {
        scope: 'https://phone.example/',
        showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options })
      },
      location: { origin: 'https://phone.example' },
      clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (u: string) => void opened.push(u) },
      skipWaiting: async () => {}
    },
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true },
    fetch: () => Promise.reject(new Error('offline')),
    URL,
    Response,
    Promise,
    setTimeout
  }
  runInNewContext(swSource, sandbox)
  const firePush = async (data: unknown): Promise<void> => {
    let done: Promise<unknown> = Promise.resolve()
    listeners.get('push')?.({ data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) }, waitUntil: (p: Promise<unknown>) => (done = p) })
    await done
  }
  await firePush(pushPayload('needs-you', 'app', 'pty-9'))
  check('a push shows its title and body, grouped by session, with the route to open', [shown[0]?.title, shown[0]?.options.body, shown[0]?.options.tag, (shown[0]?.options.data as { route: string }).route], ['app', 'Needs you', 'stoke-pty-9', '#/s/pty-9'])
  await firePush({ title: 'x', body: 'y', url: 'https://evil.example/' })
  await firePush({ title: 'x', url: 'javascript:alert(1)' })
  check('a route that is not one of the shell’s own is replaced by home', shown.slice(1).map((s) => (s.options.data as { route: string }).route), ['#/', '#/'])
  await firePush(undefined)
  check('a push with no payload still shows something (a silent push is not allowed)', shown[3]?.title, 'Stoke')
  const tap = async (route: string): Promise<void> => {
    let done: Promise<unknown> = Promise.resolve()
    listeners.get('notificationclick')?.({ notification: { close: () => {}, data: { route } }, waitUntil: (p: Promise<unknown>) => (done = p) })
    await done
  }
  windows = [{ url: 'https://phone.example/#/', postMessage: (m) => messages.push(m), focus: async () => null }]
  await tap('#/s/pty-9')
  check('a tap with the shell open tells that window where to go, and opens nothing new', [messages, opened], [[{ type: 'stoke:open', route: '#/s/pty-9' }], []])
  windows = []
  await tap('#/s/pty-9')
  check('with no window open, it opens the session', opened, ['https://phone.example/#/s/pty-9'])
}

console.log('\na private chat never reaches the phone, in either direction')
{
  /*
   * shared/privateChat.ts. The phone cannot START one: main refuses a
   * `private` launch from any origin but the desktop's own (the hub's relay
   * comes in through the same phone API). And it cannot SEE one: the phone's
   * picker is built by `folderChoices` without the desktop's `privateChat`
   * flag, so no query surfaces the row, and every list the server sends is
   * `PtyManager.list()`, which leaves private chats out (pty.ts).
   */
  const none = { host: false, install: false, enroll: false, accountLogin: false }
  check('a phone-started private chat is refused', privateLaunchProblem({ origin: 'remote', ...none }) !== null, true)
  check('the desktop may start one', privateLaunchProblem({ origin: 'desktop', ...none }), null)
  const picker = phonePickerGroups({ projects: [], defaultCwd: '/home/me', hosts: [], query: 'private', platform: 'darwin' })
  check('the phone picker never offers one, even asked by name', picker.flatMap((g) => g.items).some((c) => c.kind === 'private'), false)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
