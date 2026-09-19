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
  ENDED_RETENTION_MS,
  isGatedRemotePath,
  phoneStatusFor,
  pruneEnded,
  sortSessionRows,
  stripLocalHostnameSuffix,
  SUBMIT_CHUNK,
  submitFrames,
  trackBracketedPaste,
  typingChunks,
  type EndedRecord
} from '../src/shared/remotePhone.ts'

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
const configured = { ...base, hostname: 'code.example.com', lan: ['192.168.1.20'], tailnet: '100.64.0.9' }
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
check(
  'a choice needs no bind flag: the preference is the choice',
  connectTarget({ ...configured, reach: 'lan', bindLan: false }).reach,
  'lan'
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
check(
  'the default is the CLI\'s own',
  originCertPath({}, '/home/x'),
  '/home/x/.cloudflared/cert.pem'
)
check(
  'and TUNNEL_ORIGIN_CERT overrides it, because cloudflared honours it',
  originCertPath({ TUNNEL_ORIGIN_CERT: '/tmp/other.pem' }, '/home/x'),
  '/tmp/other.pem'
)
check('an empty override is not an override', originCertPath({ TUNNEL_ORIGIN_CERT: '  ' }, '/home/x'), '/home/x/.cloudflared/cert.pem')

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
 * ENDED_RETENTION_MS, on a fake clock over an explicit map (gotcha 74 — never
 * the real shared directory).
 */
{
  const ring = new Map<string, EndedRecord<{ id: string }>>()
  ring.set('a', { info: { id: 'a' }, endedAt: 0 })
  ring.set('b', { info: { id: 'b' }, endedAt: ENDED_RETENTION_MS - 1000 })
  pruneEnded(ring, ENDED_RETENTION_MS + 1)
  check('an entry past the retention window is dropped', ring.has('a'), false)
  check('one still inside it survives', ring.has('b'), true)
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

check('a .local suffix is stripped', stripLocalHostnameSuffix('macbookpro.local'), 'macbookpro')
check('so is .localdomain', stripLocalHostnameSuffix('desktop.localdomain'), 'desktop')
check('a bare hostname is untouched', stripLocalHostnameSuffix('macbookpro'), 'macbookpro')
check('only a trailing suffix counts', stripLocalHostnameSuffix('local.example'), 'local.example')

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
