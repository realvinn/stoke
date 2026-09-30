/*
 * What a Stoke login import will actually bring over from YOUR Chrome, on YOUR
 * Windows PC — measured, read-only, counts only.
 *
 * Chromium's source already answers the big question (gotcha 130): an app-bound
 * (v20) cookie can NEVER be decrypted from a copy of the profile, because
 * app-bound decryption is available only in the browser's DEFAULT user-data dir
 * (`kNotUsingDefaultUserDataDir` for any other), and the default dir refuses the
 * remote debugging a reader needs. Plain-DPAPI (v10) cookies do come over. Which
 * one a profile holds depends on the install: a system-level Chrome (Program
 * Files, elevation service present) writes v20; a per-user install (in
 * %LOCALAPPDATA%) has no service and writes v10. So this probe does not ask
 * whether v20 works — it measures, on your machine, how many of your cookies are
 * each kind, and confirms the prediction: every v10 comes back, every v20 stays
 * sealed and is reported. A v20 that DID come back would mean gotcha 130 is wrong.
 *
 * It is READ-ONLY against your profile: it copies the files it needs (as Stoke's
 * own reader does) and never writes to, or deletes from, your real Chrome data.
 * It prints ONLY COUNTS per registrable domain. No cookie name or value is ever
 * printed.
 *
 * Run it from a checkout of this repo, with Node 24+ (for node:sqlite):
 *
 *   # 1. QUIT the browser first — on Windows it keeps its cookie file locked
 *   #    while it runs (Chrome: menu > Exit, which keeps every window for next time).
 *   node scripts/windows-chrome-probe.mts
 *   # a different browser or profile:
 *   node scripts/windows-chrome-probe.mts --browser chrome --profile "Default"
 *   node scripts/windows-chrome-probe.mts --browser edge --profile "Profile 1"
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateChromiumExe, readChromeCookiesWin } from '../src/main/browserImport/chromeCookiesWin.ts'
import { cookieIdentity } from '../src/main/browserImport/chromeCookies.ts'
import { CHROMIUM_BROWSERS, chromiumRoot } from '../src/main/browserImport/chromiumProfiles.ts'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const browserId = arg('browser', 'chrome')
const profileName = arg('profile', 'Default')

const browser = CHROMIUM_BROWSERS.find((b) => b.id === browserId)
if (!browser) {
  console.error(`Unknown browser "${browserId}". Try one of: ${CHROMIUM_BROWSERS.map((b) => b.id).join(', ')}`)
  process.exit(1)
}
if (process.platform !== 'win32') {
  console.error('This probe is for Windows only — it measures what a login import brings over from your browser there.')
  process.exit(1)
}

const root = chromiumRoot(browser, 'win32', process.env, homedir())
if (!root) {
  console.error(`${browser.name} has no known profile root on Windows.`)
  process.exit(1)
}
const profileDir = join(root, profileName)
if (!existsSync(profileDir)) {
  console.error(`No profile at ${profileDir}. Pass --profile "<name>" (e.g. "Default", "Profile 1").`)
  process.exit(1)
}

/** Strip a leading dot and reduce a host to its registrable-ish domain (last two labels). Grouping only, never a value. */
function domainOf(host: string): string {
  const h = host.replace(/^\./, '')
  const parts = h.split('.')
  return parts.length <= 2 ? h : parts.slice(-2).join('.')
}

/** Whether Chrome has minted an app-bound key at all — the presence of the APPB blob in Local State. */
async function abeKeyPresent(): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')) as {
      os_crypt?: { app_bound_encrypted_key?: string }
    }
    const key = state.os_crypt?.app_bound_encrypted_key
    return typeof key === 'string' && key.length > 0
  } catch {
    return false
  }
}

/** Read (host_key, name, tag) from a private copy of the cookie DB. Counts only; values never touched. */
async function readTags(): Promise<{ host: string; name: string; tag: string }[]> {
  const cookieRel = existsSync(join(profileDir, 'Network', 'Cookies'))
    ? ['Network', 'Cookies']
    : existsSync(join(profileDir, 'Cookies'))
      ? ['Cookies']
      : null
  if (!cookieRel) return []
  const src = join(profileDir, ...cookieRel)
  const dir = await mkdtemp(join(tmpdir(), 'stoke-chrome-probe-'))
  const copy = join(dir, 'Cookies')
  try {
    await copyFile(src, copy)
    for (const suffix of ['-wal', '-journal']) await copyFile(src + suffix, copy + suffix).catch(() => {})
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(copy)
    try {
      const rows = db
        .prepare('SELECT host_key AS host, name AS name, hex(substr(encrypted_value, 1, 3)) AS tag FROM cookies')
        .all() as { host: string; name: string; tag: string | null }[]
      return rows.map((r) => ({
        host: String(r.host ?? ''),
        name: String(r.name ?? ''),
        tag: r.tag ? Buffer.from(String(r.tag), 'hex').toString('latin1') : ''
      }))
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const exe = await locateChromiumExe(browser)
// Chromium's `install_static::IsSystemInstall()`: a Program Files install. Only
// that kind gets the elevation service, so only that kind writes v20.
const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter((d): d is string => Boolean(d))
const systemLevel = exe ? programFiles.some((d) => exe.toLowerCase().startsWith(d.toLowerCase() + '\\')) : null
console.log(`Browser:  ${browser.name}`)
console.log(`Profile:  ${profileDir}`)
console.log(`Exe:      ${exe ?? '(not located — the reader will fail)'}`)
console.log(
  `Install:  ${systemLevel === null ? 'unknown' : systemLevel ? 'system-level (Program Files) — writes app-bound v20' : 'per-user — no elevation service, writes v10'}`
)
console.log(`ABE key:  ${(await abeKeyPresent()) ? 'present (app-bound key minted)' : 'absent'}`)

const tags = await readTags()
const v10 = tags.filter((t) => t.tag === 'v10').length
const v20 = tags.filter((t) => t.tag === 'v20').length
console.log(`\nCookie DB: ${tags.length} rows — v10 (plain DPAPI) ${v10}, v20 (app-bound) ${v20}, other ${tags.length - v10 - v20}`)
if (v20 === 0) {
  console.log('\nNo v20 rows in this profile — nothing app-bound to prove here. Open a few sites, sign in, then retry.')
}

console.log('\nDriving the browser to decrypt from a copy (this launches it headless; read-only against your profile)…')
let decrypted: { domain: string; name: string }[] = []
let sealedNote = ''
try {
  const read = await readChromeCookiesWin(browser, profileDir, exe ? { exePath: exe } : {})
  if (read.needsClose) {
    console.error(`\n${read.cookieError}`)
    console.error('Quit the browser completely (Chrome: menu > Exit), then run this again.')
    process.exit(1)
  }
  // Only the identities come back into this script; values stay in the reader.
  decrypted = read.cookies.map((c) => ({ domain: domainOf((c.domain ?? new URL(c.url).hostname) || ''), name: c.name }))
  if (read.cookieError) sealedNote = read.cookieError
  console.log(`Reader returned ${read.cookies.length} decrypted cookie(s), ${read.skipped} skipped.`)
} catch (err) {
  console.error(`\nThe reader could not run: ${err instanceof Error ? err.message : String(err)}`)
  console.error('If it says the profile is locked, close the browser completely and run this again.')
  process.exit(1)
}

// Which v20 rows came back? Match by (registrable-domain, name). CDP returns the
// domain with/without a leading dot; both reduce to the same registrable domain.
const decryptedIds = new Set(decrypted.map((d) => cookieIdentity(d.domain, d.name)))
type Row = { v10: number; v10Decrypted: number; v20: number; v20Decrypted: number }
const perDomain = new Map<string, Row>()
for (const t of tags) {
  const d = domainOf(t.host)
  const row = perDomain.get(d) ?? { v10: 0, v10Decrypted: 0, v20: 0, v20Decrypted: 0 }
  const back = decryptedIds.has(cookieIdentity(d, t.name))
  if (t.tag === 'v10') {
    row.v10++
    if (back) row.v10Decrypted++
  } else if (t.tag === 'v20') {
    row.v20++
    if (back) row.v20Decrypted++
  }
  perDomain.set(d, row)
}

console.log('\nPer domain — counts only, no names, no values (a v10 row can be dropped legitimately: expired):')
console.log('  domain'.padEnd(40) + 'v10  v10-back  v20  v20-back')
const total = { v10: 0, v10Decrypted: 0, v20: 0, v20Decrypted: 0 }
for (const [domain, row] of [...perDomain.entries()].sort((a, b) => b[1].v10 + b[1].v20 - (a[1].v10 + a[1].v20))) {
  if (row.v10 === 0 && row.v20 === 0) continue
  total.v10 += row.v10
  total.v10Decrypted += row.v10Decrypted
  total.v20 += row.v20
  total.v20Decrypted += row.v20Decrypted
  console.log(
    '  ' + domain.padEnd(38) + String(row.v10).padEnd(5) + String(row.v10Decrypted).padEnd(10) + String(row.v20).padEnd(5) + String(row.v20Decrypted)
  )
}

console.log('\nVerdict:')
console.log(`  v10 (plain DPAPI): ${total.v10Decrypted} of ${total.v10} came back — these are what an import brings over.`)
if (total.v20 === 0) {
  console.log('  v20 (app-bound): none in this profile, so nothing stays sealed here.')
} else if (total.v20Decrypted === 0) {
  console.log(`  v20 (app-bound): all ${total.v20} stayed sealed, as Chromium's source predicts (gotcha 130) — an import reports them, never brings them.`)
} else {
  console.log(`  v20 (app-bound): ${total.v20Decrypted} of ${total.v20} CAME BACK from a copy — this CONTRADICTS gotcha 130. Please report this line.`)
}
if (sealedNote) console.log(`  Reader said: ${sealedNote}`)
console.log('\nNothing but these counts left this machine.')
