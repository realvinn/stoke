// Build-time only. The account cleanup helper loads this fixed managed library;
// it must never start a compiler in the installed application.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const WINDOWS_IDENTITY_LIBRARY_NAME = 'StokeIdentityNative.dll'
const compilerFlags = ['/nologo', '/noconfig', '/target:library', '/platform:anycpu', '/optimize+', '/debug-', '/warnaserror+']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Require an IL-only AnyCPU DLL, not an architecture-specific native image. */
export function assertWindowsIdentityImage(bytes) {
  const bad = () => { throw new Error('Windows identity library must be an IL-only AnyCPU managed DLL') }
  if (!Buffer.isBuffer(bytes) || bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) bad()
  const pe = bytes.readUInt32LE(0x3c)
  if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) bad()
  const sections = bytes.readUInt16LE(pe + 6)
  const optionalSize = bytes.readUInt16LE(pe + 20)
  const optional = pe + 24
  // csc /platform:anycpu uses PE32 + I386 metadata with ILONLY, which the CLR
  // loads natively in either x64 or ARM64 PowerShell. It is not native x86 code.
  if (bytes.readUInt16LE(pe + 4) !== 0x14c || !(bytes.readUInt16LE(pe + 22) & 0x2000)) bad()
  if (optionalSize < 224 || optional + optionalSize + sections * 40 > bytes.length || bytes.readUInt16LE(optional) !== 0x10b) bad()
  if (bytes.readUInt32LE(optional + 92) < 15) bad()
  const rvaToOffset = (rva, size) => {
    for (let i = 0; i < sections; i++) {
      const section = optional + optionalSize + i * 40
      const address = bytes.readUInt32LE(section + 12)
      const rawSize = bytes.readUInt32LE(section + 16)
      const raw = bytes.readUInt32LE(section + 20)
      if (rva >= address && rva - address + size <= rawSize && raw + rva - address + size <= bytes.length) return raw + rva - address
    }
    bad()
  }
  const cliSize = bytes.readUInt32LE(optional + 96 + 14 * 8 + 4)
  if (cliSize < 72) bad()
  const cli = rvaToOffset(bytes.readUInt32LE(optional + 96 + 14 * 8), 72)
  const flags = bytes.readUInt32LE(cli + 16)
  if (!(flags & 1) || flags & (2 | 0x20000)) bad()
  const metadata = rvaToOffset(bytes.readUInt32LE(cli + 8), 4)
  if (bytes.readUInt32LE(metadata) !== 0x424a5342 || !bytes.includes(Buffer.from('StokeIdentityNative'))) bad()
}

/** Native Windows builds and Node verification suites share this cached output. */
export async function buildWindowsIdentityLibrary() {
  if (process.platform !== 'win32') return null
  const source = join(projectRoot, 'build', 'windows-identity', 'StokeIdentityNative.cs')
  const sourceBytes = await readFile(source)
  if (/[^\x00-\x7f]/.test(sourceBytes.toString('utf8'))) throw new Error('Windows identity native source must remain fixed ASCII')
  const out = join(projectRoot, 'out', 'native', 'windows-identity')
  const library = join(out, WINDOWS_IDENTITY_LIBRARY_NAME)
  const manifest = join(out, 'build.json')
  const sourceHash = digest(Buffer.concat([sourceBytes, Buffer.from(compilerFlags.join('\0'))]))
  try {
    const [saved, bytes] = await Promise.all([readFile(manifest, 'utf8').then(JSON.parse), readFile(library)])
    if (saved.sourceHash === sourceHash && saved.libraryHash === digest(bytes)) {
      assertWindowsIdentityImage(bytes)
      return library
    }
  } catch { /* absent, stale or damaged output is rebuilt */ }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  let compiler
  // Framework's compiler ships with Windows; no SDK, PATH lookup or runtime
  // compilation is involved. All variants emit the same AnyCPU ABI.
  for (const folder of ['FrameworkArm64', 'Framework64', 'Framework']) {
    const candidate = join(systemRoot, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe')
    if (await stat(candidate).then(value => value.isFile(), () => false)) { compiler = candidate; break }
  }
  if (!compiler) throw new Error('The Windows .NET Framework C# compiler is required to build the identity cleanup library')
  await mkdir(out, { recursive: true })
  const staging = await mkdtemp(join(out, '.compile-'))
  try {
    const stagedLibrary = join(staging, WINDOWS_IDENTITY_LIBRARY_NAME)
    // csc is an exact owned build child. No shell, compiler server, response
    // file, agent data or installed-app invocation reaches this command.
    await new Promise((resolveBuild, reject) => execFile(compiler, [...compilerFlags, `/out:${stagedLibrary}`, source], { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { error.message += `\n${String(stdout)}${String(stderr)}`; reject(error) }
      else resolveBuild()
    }))
    const bytes = await readFile(stagedLibrary)
    assertWindowsIdentityImage(bytes)
    await rename(stagedLibrary, library)
    await writeFile(manifest, JSON.stringify({ sourceHash, libraryHash: digest(bytes) }) + '\n')
    console.log('Built the IL-only AnyCPU Windows account identity library.')
    return library
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildWindowsIdentityLibrary()
}
