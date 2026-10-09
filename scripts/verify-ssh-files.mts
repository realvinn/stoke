/** Real POSIX descriptor walks plus the native desktop/HTTP transfer plumbing.
 * Windows exercises the same binary client against isolated Node subprocesses;
 * the Python helper there must explicitly refuse the unsupported execution host. */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { SshFiles, SshFileError, sshFileArgs } from '../src/main/sshFiles.ts'
import { SSH_FILE_READER } from '../src/main/sshFileReader.ts'
import { DesktopSshFiles } from '../src/main/desktopSshFiles.ts'
import { PhoneFiles, PhoneFileError } from '../src/main/remote/files.ts'
import { sshDownloadFolder, MAX_FILE_BYTES } from '../src/shared/remoteFiles.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { hostPayloadFor, applySyncedSettings } from '../src/shared/hub/settings.ts'
import type { SshHost } from '../src/shared/types.ts'

let failures = 0
let passes = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passes++; else failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n    got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
async function status(work: Promise<unknown>): Promise<number> {
  try { await work; return 0 } catch (error) { return error instanceof SshFileError || error instanceof PhoneFileError ? error.status : -1 }
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
// AF_UNIX paths are limited to ~104 bytes on macOS, below its long TMPDIR.
const work = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'stoke-sf-'))
const root = join(work, 'café 日本語 $(data)')
const outside = join(work, 'outside')
const spool = join(work, 'spool')
const destination = join(outside, 'saved.txt')
const signal = new AbortController().signal
let hosts: SshHost[] = []
const body = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256))
const header = (value: Record<string, unknown>): string => JSON.stringify({ protocol: 'stoke-files-1', ...value }) + '\n'
/** Native subprocess, with stdin consumed just as SSH's remote command does. */
const nodeReader = (output: string, exit = 0, binary = false): SshFiles => new SshFiles({ tempRoot: spool, start: () => spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${binary ? `Buffer.from(${JSON.stringify(output)},'base64')` : JSON.stringify(output)});process.exitCode=${exit};});`]) })
try {
  await mkdir(root); await mkdir(outside); await mkdir(spool)
  const host: SshHost = { id: 'host-1', label: 'Remote fixture', alias: 'never-a-real-host', command: '', downloadFolder: root.replaceAll('\\', '/') }
  // The helper runs on POSIX; a Windows client still sends a POSIX root.
  if (process.platform === 'win32') host.downloadFolder = '/fixture/project'
  hosts = [host]
  check('download folders require explicit remote absolute/home paths', [sshDownloadFolder(undefined), sshDownloadFolder('relative'), sshDownloadFolder('/a/../b'), sshDownloadFolder('~/project'), sshDownloadFolder('/a/日本語'), sshDownloadFolder('/a\nb')], ['', '', '', '~/project', '/a/日本語', ''])
  check('old hosts hydrate with downloads disabled; hand-edited traversal stays disabled', [hydrateSettings({ hosts: [{ ...host, downloadFolder: undefined }] }).hosts[0].downloadFolder, hydrateSettings({ hosts: [{ ...host, downloadFolder: '/a/../b' }] }).hosts[0].downloadFolder], ['', ''])
  const syncId = 'haaaaaaaaaaaaaaaa'
  const current = hydrateSettings({ hosts: [{ ...host, syncId }] })
  check('remote folder permission never leaves in a hub host payload', 'downloadFolder' in hostPayloadFor(host).host, false)
  const incoming = { host: { label: 'Updated', alias: host.alias, command: '', downloadFolder: '/unrequested' }, keyRefs: [] }
  check('incoming same-host permission is ignored while local permission is kept', hydrateSettings(applySyncedSettings(current, { hosts: { [syncId]: incoming } } as never).raw).hosts[0].downloadFolder, host.downloadFolder)
  check('a changed remote alias revokes the old folder permission', hydrateSettings(applySyncedSettings(current, { hosts: { [syncId]: { ...incoming, host: { ...incoming.host, alias: 'changed-host' } } } } as never).raw).hosts[0].downloadFolder, '')
  check('a newly synced host never gains downloads from the payload', hydrateSettings(applySyncedSettings(hydrateSettings({}), { hosts: { [syncId]: incoming } } as never).raw).hosts[0].downloadFolder, '')
  const args = sshFileArgs(host)!
  check('copy connections disable PTY, forwarding, LocalCommand and agent forwarding', ['-T', 'BatchMode=yes', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ForwardAgent=no', 'RemoteCommand=none', 'ControlMaster=no'].map((value) => args.includes(value)), Array(7).fill(true))
  check('only the static reader enters shell code, never the chosen root or connect command', [args.at(-1)?.startsWith('python3 -I -c '), args.join(' ').includes(root), sshFileArgs({ ...host, alias: '-oProxyCommand=bad' })], [true, false, null])
  let starts = 0
  const python = new SshFiles({ tempRoot: spool, start: () => { starts++; return spawn(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', SSH_FILE_READER]) } })
  check('permission and traversal are refused before starting any subprocess', [await status(python.list({ ...host, downloadFolder: '' }, '', signal)), await status(python.download(host, '../outside/x', signal)), await status(python.download(host, '/absolute', signal)), starts], [403, 400, 400, 0])
  if (process.platform === 'win32') {
    check('a native Windows execution host is refused honestly by the Python helper', await status(python.list(host, '', signal)), 400)
  } else {
    const name = '日本語 $(touch sentinel) \'quoted\'.bin'
    await writeFile(join(root, name), body)
    await writeFile(join(root, 'empty.txt'), '')
    await writeFile(join(root, '.hidden'), 'hidden')
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'café.txt'), 'nested')
    await symlink(outside, join(root, 'escape'))
    await symlink(join(root, name), join(root, 'linked.bin'))
    const before = await readdir(root)
    const listing = await python.list(host, '', signal)
    check('real descriptor listing offers regular files/folders and excludes hidden paths and symlinks', [listing.entries.some((e) => e.name === name), listing.entries[0].name, listing.entries.some((e) => ['escape', 'linked.bin', '.hidden'].includes(e.name))], [true, 'docs', false])
    const progress: number[] = []
    const opened = await python.download(host, name, signal, (p) => progress.push(p.received))
    check('a real Unicode/metacharacter download has every binary byte and the exact filename', [opened.name, opened.size, Buffer.compare(await opened.file.readFile(), body)], [name, body.length, 0])
    check('download progress begins at zero and reaches the verified byte count', [progress[0], progress.at(-1)], [0, body.length])
    check('private spool permissions keep downloaded bytes owner-only', (await opened.file.stat()).mode & 0o777, 0o600)
    await opened.dispose()
    check('download disposal removes the temporary file and folder', await readdir(spool), [])
    check('remote reads never mutate the chosen root or execute a filename', await readdir(root), before)
    const empty = await python.download(host, 'empty.txt', signal)
    check('a zero-byte remote file is a complete file', [empty.size, (await empty.file.readFile()).length], [0, 0]); await empty.dispose()
    check('nested relative downloads stay in the configured root', (await python.list(host, 'docs', signal)).entries[0].path, 'docs/café.txt')
    check('links outside and links inside the root both refuse download', [await status(python.download(host, 'escape/secret.txt', signal)), await status(python.download(host, 'linked.bin', signal)), await status(python.list(host, 'escape', signal))], [403, 403, 403])
    check('folders are never presented as file downloads', await status(python.download(host, 'docs', signal)), 400)
    const sparse = await open(join(root, 'huge.bin'), 'wx'); await sparse.truncate(MAX_FILE_BYTES + 1); await sparse.close()
    check('an actual over-limit sparse file is refused before its bytes are read', await status(python.download(host, 'huge.bin', signal)), 413)
    await promisify(execFile)('mkfifo', [join(root, 'pipe')])
    check('an actual FIFO is refused without blocking an open', await status(python.download(host, 'pipe', signal)), 400)
    const socket = createServer()
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(join(root, 'socket'), resolve) })
    check('a Unix socket is not a downloadable file', await status(python.download(host, 'socket', signal)), 502)
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    await mkdir(join(root, 'many'))
    await Promise.all(Array.from({ length: 220 }, (_, i) => writeFile(join(root, 'many', `item-${i}.txt`), '')))
    const limited = await python.list(host, 'many', signal)
    check('large folder listings are explicitly capped', [limited.entries.length, limited.truncated], [200, true])
    const missing = { ...host, downloadFolder: join(work, 'missing') }
    check('an inaccessible configured root cannot silently fall back to home', await status(python.list(missing, '', signal)), 404)
    const phone = new PhoneFiles(python)
    const fromPhone = await phone.download({ cwd: outside, host }, 'docs/café.txt', signal)
    check('phone downloads use the SSH folder rather than the desktop cwd', await fromPhone.file.readFile('utf8'), 'nested'); await fromPhone.dispose()
    check('the phone adapter preserves disabled-host permission errors', await status(phone.list({ cwd: root, host: { ...host, downloadFolder: '' } }, '', signal)), 403)
  }

  for (const [name, output, code] of [
    ['missing bytes', header({ size: 4 }) + 'abc', 0],
    ['extra bytes', header({ size: 2 }) + 'abc', 0],
    ['failed final exit', header({ size: 3 }) + 'abc', 3],
    ['login-shell noise', 'welcome\n' + header({ size: 3 }) + 'abc', 0],
    ['untrusted size', header({ size: String(MAX_FILE_BYTES) }), 0],
    ['oversized declaration', header({ size: MAX_FILE_BYTES + 1 }), 0]
  ] as const) check(`${name} never produces a completed download`, await status(nodeReader(output, code).download(host, 'file.txt', signal)), 502)
  check('malformed listings cannot inject an absolute or escaping path', await status(nodeReader(header({ path: '', truncated: false, entries: [{ name: 'safe', path: '../escape', kind: 'file', size: 1 }] })).list(host, '', signal)), 502)
  check('listing data rejects a non-boolean truncation indicator', await status(nodeReader(header({ path: '', truncated: 'yes', entries: [] })).list(host, '', signal)), 502)
  check('a failed or malformed stream leaves no partial spool', await readdir(spool), [])
  const binary = Buffer.concat([Buffer.from(header({ size: body.length })), body]).toString('base64')
  // Keep the large bytes out of command-line argv; this child writes a file
  // created by the suite, like the real helper reading its own regular file.
  const binaryFile = join(work, 'wire.bin')
  await writeFile(binaryFile, Buffer.from(binary, 'base64'))
  const reader = new SshFiles({ tempRoot: spool, start: () => spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>require('node:fs').createReadStream(${JSON.stringify(binaryFile)}).pipe(process.stdout));`]) })
  const progress: number[] = []
  let pickerCalls = 0
  const desktop = new DesktopSshFiles({ hosts: () => hosts, reader, chooseSave: async () => { pickerCalls++; return destination }, progress: (p) => progress.push(p.received) })
  await writeFile(destination, 'old destination')
  const saved = await desktop.save({ requestId: 'desktop-request-1', hostId: host.id, path: 'file.txt' })
  check('the desktop saves every byte only after a native-picked destination', [saved, pickerCalls, Buffer.compare(await readFile(destination), body), progress.at(-1)], [{ ok: true, saved: true }, 1, 0, body.length])
  check('desktop success leaves no temporary files beside the destination or in the spool', [(await readdir(outside)).filter((p) => p.startsWith('.stoke-download-')), await readdir(spool)], [[], []])
  const broken = new DesktopSshFiles({ hosts: () => hosts, reader: nodeReader(header({ size: 8 }) + 'short'), chooseSave: async () => destination, progress: () => {} })
  await writeFile(destination, 'preserve this')
  check('an interrupted desktop save reports failure and preserves the previous destination', [(await broken.save({ requestId: 'desktop-request-2', hostId: host.id, path: 'file.txt' })).ok, await readFile(destination, 'utf8')], [false, 'preserve this'])
  let choose: ((path: string | null) => void) | null = null
  const waiting = new DesktopSshFiles({ hosts: () => hosts, reader, chooseSave: () => new Promise((resolve) => { choose = resolve }), progress: () => {} })
  const first = waiting.save({ requestId: 'waiting-request-1', hostId: host.id, path: 'file.txt' })
  check('a second action is refused while the save dialog is unresolved', (await waiting.list({ requestId: 'waiting-request-2', hostId: host.id, path: '' })).ok, false)
  waiting.cancel('waiting-request-1')
  check('cancel retains ownership until the pending dialog actually finishes', (await waiting.list({ requestId: 'waiting-request-3', hostId: host.id, path: '' })).ok, false)
  choose!(destination)
  check('a cancelled picker cannot start a download afterward', (await first).ok, false)
  const changed = waiting.save({ requestId: 'waiting-request-4', hostId: host.id, path: 'file.txt' })
  hosts = [{ ...host, downloadFolder: '' }]
  choose!(destination)
  check('revoking the folder while the picker is open prevents any subsequent download', (await changed).ok, false)
  hosts = [host]
  const stall = new SshFiles({ tempRoot: spool, timeoutMs: 100, idleMs: 500, start: () => spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000);']) })
  check('an actual subprocess deadline cancels the child and cleans its partial spool', [await status(stall.download(host, 'file.txt', signal)), await readdir(spool)], [504, []])
  const abort = new AbortController()
  const slow = new SshFiles({ tempRoot: spool, start: () => spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000);']) })
  const cancelled = slow.download(host, 'file.txt', abort.signal)
  await pause(100); abort.abort()
  check('actual cancellation waits for child close and removes the partial spool', [await status(cancelled), await readdir(spool)], [408, []])
} finally { await rm(work, { recursive: true, force: true }) }
console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
