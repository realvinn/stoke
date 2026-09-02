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
import { clampPort } from '../src/shared/ui.ts'

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
check(
  'a configured hostname is the tunnel, over https, with no port',
  connectTarget({ ...base, hostname: 'code.example.com', bindLan: true, lan: ['192.168.1.20'], tailnet: null }),
  { url: 'https://code.example.com/?k=k3y', reach: 'tunnel', address: 'code.example.com', candidates: ['http://192.168.1.20:7878/?k=k3y'] }
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

console.log('\nthe port box')
check('a real port is kept', clampPort(8080), 8080)
check('the default when cleared', clampPort(''), 7878)
check('a privileged port is refused', clampPort(80), 7878)
check('so is one past the top', clampPort(65536), 7878)
check('a string from an input box is read', clampPort('9000'), 9000)
check('a fraction is refused', clampPort(8080.5), 7878)

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
