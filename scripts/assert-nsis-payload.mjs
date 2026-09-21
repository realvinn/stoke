/*
 * Read a built Windows installer back and refuse one its own extractor cannot
 * unpack.
 *
 *   node scripts/assert-nsis-payload.mjs release
 *
 * The bug this exists for (gotcha 102): electron-builder packs the app into a
 * 7z inside the NSIS installer, and at install time NSIS's nsis7z plugin
 * (FileVersion 19.00) extracts it. 7-Zip 23.01 added an ARM64 branch filter and
 * picks it by itself for ARM64 executables; nsis7z 19.00 has BCJ, BCJ2, PPC,
 * IA64, ARM, ARMT and SPARC and nothing newer. So the v0.9.9 arm64 installer
 * — built on GitHub's windows-11-arm runner — stored Stoke.exe and every DLL as
 * `ARM64 LZMA2`, and on a real arm64 machine it exited 0, wrote its registry
 * keys and installed NO files. No build error, no install error, a green
 * release: nothing but opening the installer can see it.
 *
 * So this opens every `release/*-setup.exe` with the full 7-Zip (which reads
 * NSIS installers; the 7za electron-builder bundles does not), pulls out the
 * embedded `$PLUGINSDIR\app-<arch>.7z`, lists the method of every file in it,
 * and fails on any filter nsis7z 19.00 lacks. It also asserts Stoke.exe is in
 * the payload at all. Run by the release workflow and the Windows workflow on
 * every Windows build; it needs Windows only because that is where 7z.exe is
 * (GitHub's Windows images ship C:\Program Files\7-Zip\7z.exe).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Filters nsis7z 19.00 cannot decode. Anything 7-Zip added after 19.00 belongs here. */
const UNDECODABLE = ['ARM64', 'RISCV']

function sevenZip() {
  const candidates = [
    process.env.SEVEN_ZIP,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
    '/opt/homebrew/bin/7zz',
    '/usr/local/bin/7zz',
    '/usr/bin/7z'
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

function fail(msg) {
  console.error(`FAIL  ${msg}`)
  process.exitCode = 1
}

const dir = process.argv[2] ?? 'release'
const exe = sevenZip()
if (!exe) {
  console.error('No full 7-Zip (7z.exe / 7zz) found to open the installer with. Set SEVEN_ZIP to one.')
  process.exit(1)
}
const installers = readdirSync(dir).filter((f) => /-setup\.exe$/i.test(f))
if (!installers.length) {
  console.error(`No *-setup.exe in ${dir}`)
  process.exit(1)
}

const run = (args) => execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })

for (const name of installers) {
  const setup = join(dir, name)
  const listing = run(['l', '-slt', setup])
  const payloads = [...listing.matchAll(/^Path = (\$PLUGINSDIR[\\/]app-[\w-]+\.7z)$/gm)].map((m) => m[1])
  if (!payloads.length) {
    fail(`${name}: no embedded $PLUGINSDIR\\app-<arch>.7z found — cannot check what it installs`)
    continue
  }
  for (const payload of payloads) {
    const tmp = mkdtempSync(join(tmpdir(), 'stoke-nsis-'))
    try {
      run(['e', '-y', `-o${tmp}`, setup, payload])
      const inner = join(tmp, payload.split(/[\\/]/).pop())
      const detail = run(['l', '-slt', inner])
      const methods = new Set([...detail.matchAll(/^Method = (.+)$/gm)].map((m) => m[1].trim()))
      const bad = [...methods].filter((m) => UNDECODABLE.some((f) => new RegExp(`\\b${f}\\b`).test(m)))
      console.log(`${name} ${payload}: methods ${[...methods].join(' | ')}`)
      if (bad.length) {
        fail(`${name}: ${payload} uses ${bad.join(', ')}, which the installer's own nsis7z (19.00) cannot decode — it would exit 0 and install nothing. Build with ELECTRON_BUILDER_7Z_FILTER=BCJ (gotcha 102).`)
      }
      if (!/^Path = Stoke\.exe$/m.test(detail)) fail(`${name}: ${payload} holds no Stoke.exe at its root`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

if (!process.exitCode) console.log('every installer payload is one its own extractor can read')
