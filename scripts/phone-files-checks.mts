/** Real file streams and the production HTTP router, with only Electron and PTYs replaced. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createServer, request } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PhoneFiles, PhoneFileError } from '../src/main/remote/files.ts'
import { phoneFileNameProblem, phoneRelativePath, phoneFileSize } from '../src/shared/remoteFiles.ts'
import { MAX_FILE_BYTES } from '../src/shared/imageUpload.ts'
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'

type Check = (name: string, got: unknown, want: unknown) => void
export async function phoneFilesChecks(check: Check): Promise<void> {
  console.log('\nphone files: binary streams, destinations, cancellation and the actual HTTP gate')
  const work = await mkdtemp(join(tmpdir(), 'stoke-phone-files-'))
  let server: { start: (config: unknown) => Promise<{ running: boolean; error: unknown }>; stop: () => Promise<void> } | null = null
  const controller = new AbortController()
  const body = Buffer.from('A file with café and 日本語.\n'.repeat(8000))
  const input = async function* () { yield body.subarray(0, 13); yield body.subarray(13) }
  const rejectStatus = async (work: Promise<unknown>): Promise<number> => { try { await work; return 0 } catch (error) { return error instanceof PhoneFileError ? error.status : -1 } }
  try {
    const root = join(work, 'project')
    const outside = join(work, 'outside')
    await mkdir(root); await mkdir(outside)
    await writeFile(join(root, 'bystander.txt'), 'leave this alone')
    await writeFile(join(root, 'café-日本語.txt'), body)
    await writeFile(join(root, 'empty.txt'), '')
    await writeFile(join(outside, 'secret.txt'), 'outside')
    const files = new PhoneFiles()
    const target = { cwd: root, host: null }
    const sent = await files.upload(target, 'café-日本語.txt', body.length, input(), controller.signal)
    check('Unicode-named uploads keep their bytes and return the actual saved name', [Buffer.compare(await readFile(sent.path), body), sent.path.endsWith(sent.name), sent.destination], [0, true, 'local'])
    check('a pre-existing project file is never overwritten', await readFile(join(root, 'bystander.txt'), 'utf8'), 'leave this alone')
    const opened = await files.download(target, 'café-日本語.txt')
    check('a download preserves its Unicode name and all bytes', [opened.name, opened.size, Buffer.compare(await opened.file.readFile(), body)], ['café-日本語.txt', body.length, 0])
    await opened.file.close()
    check('filename controls and relative paths reject traversal and control bytes', [phoneFileNameProblem('../x') !== null, phoneFileNameProblem('x\ny') !== null, phoneRelativePath('../x'), phoneRelativePath('/x'), phoneRelativePath('a\\b'), phoneRelativePath('docs/日本語.txt')], [true, true, false, false, false, true])
    check('zero-byte files are allowed; unknown, fractional and over-limit sizes are not', [phoneFileSize(0), phoneFileSize(NaN), phoneFileSize(1.5), phoneFileSize(MAX_FILE_BYTES + 1)], [true, false, false, false])
    const before = (await readdir(root)).sort()
    check('a truncated upload is refused', await rejectStatus(files.upload(target, 'short.txt', body.length + 1, input(), controller.signal)), 400)
    check('a stream longer than declared is refused', await rejectStatus(files.upload(target, 'long.txt', body.length - 1, input(), controller.signal)), 413)
    const abort = new AbortController()
    const cancelled = async function* () { yield body.subarray(0, 1); abort.abort(); yield body.subarray(1) }
    check('a cancelled upload is refused', await rejectStatus(files.upload(target, 'cancel.txt', body.length, cancelled(), abort.signal)), 408)
    check('failed sends leave no complete or partial local files', (await readdir(root)).sort(), before)
    const empty = await files.upload(target, 'empty.txt', 0, (async function* () {})(), controller.signal)
    check('an empty upload completes with zero bytes', (await readFile(empty.path)).length, 0)
    const one = files.claim('one'); const two = files.claim('two')
    check('a third transfer and a duplicate request are refused before any await', [await rejectStatus(Promise.resolve().then(() => files.claim('three'))), await rejectStatus(Promise.resolve().then(() => files.claim('one')))], [409, 409])
    one(); const replacement = files.claim('one'); one()
    check('an older release cannot drop the replacement claim', await rejectStatus(Promise.resolve().then(() => files.claim('one'))), 409)
    replacement(); two()
    const host = { id: 'ssh-host', alias: 'fixture-host', label: 'Fixture', command: '', noUploads: false }
    let forwarded = Buffer.alloc(0)
    const onSsh = await files.upload({ cwd: outside, host } as never, '日本語.txt', body.length, input(), controller.signal, async (receivedHost, name, up) => {
      check('an SSH send selects the execution host', receivedHost.id, 'ssh-host')
      const chunks: Uint8Array[] = []
      for await (const chunk of (up.input as () => AsyncIterable<Uint8Array>)()) chunks.push(chunk)
      forwarded = Buffer.concat(chunks)
      return { ok: true, path: `/remote/cache/${name}` }
    })
    check('SSH receives a binary stream and returns a host-valid path', [Buffer.compare(forwarded, body), onSsh.path.startsWith('/remote/cache/'), onSsh.destination], [0, true, 'ssh'])
    check('SSH sends never write into the desktop cwd', await readdir(outside), ['secret.txt'])
    check('an opted-out SSH host refuses file sends', await rejectStatus(files.upload({ cwd: root, host: { ...host, noUploads: true } } as never, 'file.txt', body.length, input(), controller.signal)), 403)
    check('SSH downloads require an explicitly configured remote folder', await rejectStatus(files.download({ cwd: root, host } as never, 'x')), 403)
    let linked = false
    try { await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true } catch { /* Windows without symlink permission */ }
    if (linked) {
      check('a symlink to another folder cannot be downloaded or browsed', [await rejectStatus(files.download(target, 'escape/secret.txt')), await rejectStatus(files.list(target, 'escape'))], [403, 403])
    }
    const listing = await files.list(target, '')
    check('browse offers visible regular files and excludes upload folders and symlinks', [listing.entries.some((e) => e.name === 'café-日本語.txt'), listing.entries.some((e) => e.name === 'escape' || e.name.startsWith('.'))], [true, false])

    const rootDir = fileURLToPath(new URL('../', import.meta.url))
    const bundle = join(work, 'remote.cjs')
    await build({ stdin: { contents: `export { RemoteServer } from './src/main/remote/server.ts'; export { SshFiles } from './src/main/sshFiles.ts';`, resolveDir: rootDir, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
      // The temporary bundle uses the workspace's dependencies, never a global install.
      banner: { js: `require = require('node:module').createRequire(${JSON.stringify(join(rootDir, 'package.json'))});` },
      plugins: [{ name: 'electron-test-shell', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'phone-test' }))
        builder.onLoad({ filter: /.*/, namespace: 'phone-test' }, () => ({ contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(rootDir)} };`, loader: 'js' }))
      } }] })
    const { RemoteServer, SshFiles } = createRequire(import.meta.url)(bundle)
    const sessions = [{ ptyId: 'local', sessionId: 'local-session', cwd: root, cli: 'codex', exited: false, enroll: false, accountLogin: false }, { ptyId: 'ssh', sessionId: 'ssh-session', cwd: outside, cli: 'claude', exited: false, enroll: false, accountLogin: false }]
    const ptys = { list: () => sessions, launchFacts: (id: string) => ({ hostId: id === 'ssh' ? 'ssh-host' : null }), subscribe: () => () => {}, subscribeExit: () => () => {} }
    const sshRoot = join(work, 'ssh-spool'); await mkdir(sshRoot)
    const wireBytes = join(work, 'ssh-wire.bin'); await writeFile(wireBytes, body)
    const started = join(work, 'ssh-started')
    const wireScript = join(work, 'ssh-wire.mjs')
    await writeFile(wireScript, `import { createReadStream, writeFileSync } from 'node:fs';
let raw='';for await(const chunk of process.stdin) raw+=chunk;const req=JSON.parse(raw);
const header=(value)=>process.stdout.write(JSON.stringify({protocol:'stoke-files-1',...value})+'\\n');
if(req.path==='slow.bin'){writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000);}
else if(req.operation==='list'){header({path:req.path,entries:[{name:'remote.bin',path:req.path?req.path+'/remote.bin':'remote.bin',kind:'file',size:${body.length}}],truncated:false});}
else{header({size:${body.length}});createReadStream(${JSON.stringify(wireBytes)}).pipe(process.stdout);}`)
    const configuredHost = { ...host, noUploads: true, downloadFolder: '' }
    const sshReader = new SshFiles({ tempRoot: sshRoot, start: () => spawn(process.execPath, [wireScript]) })
    server = new RemoteServer({ ptys: () => ptys, theme: () => ({ theme: BUILT_IN_THEMES[0], fontFamily: 'monospace' }), hosts: () => [configuredHost], sshFiles: sshReader })
    // Reserve and release an ephemeral port; start's real listener owns it thereafter.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const status = await server!.start({ port, token: 'phone-file-fixture', hostname: '', bindLan: false, bindTailscale: false, requireAccessHeader: false })
    check('the production remote HTTP server starts without a GUI', [status.running, status.error], [true, null])
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: 'Bearer phone-file-fixture', 'content-type': 'application/octet-stream' }
    const upload = (id: string, name: string, size: number, bytes: Uint8Array, extra: Record<string, string> = {}) => fetch(`${base}/api/files/upload?${new URLSearchParams({ ptyId: id, name, size: String(size) })}`, { method: 'POST', headers: { ...headers, ...extra }, body: bytes })
    check('an unpaired HTTP upload is rejected before creating a file', (await upload('local', 'denied.txt', 1, new Uint8Array([1]), { authorization: 'Bearer wrong-key' })).status, 401)
    check('a cross-origin upload is rejected even with the key', (await upload('local', 'denied.txt', 1, new Uint8Array([1]), { origin: 'https://foreign.example' })).status, 403)
    check('an unknown session cannot choose a destination', (await upload('missing', 'denied.txt', 1, new Uint8Array([1]))).status, 404)
    check('SSH opt-out is honored through the actual HTTP route', (await upload('ssh', 'denied.txt', 1, new Uint8Array([1]))).status, 403)
    check('HTTP rejects over-limit declarations before reading a body', (await upload('local', 'huge.txt', MAX_FILE_BYTES + 1, new Uint8Array([1]))).status, 413)
    const response = await upload('local', 'café-日本語.txt', body.length, body)
    const saved = await response.json() as { path: string; name: string }
    check('the HTTP upload returns success only after the real file is complete', [response.status, Buffer.compare(await readFile(saved.path), body)], [200, 0])
    const fileResponse = await fetch(`${base}/api/files/download?${new URLSearchParams({ ptyId: 'local', path: 'café-日本語.txt' })}`, { headers })
    check('the HTTP download is an attachment, never cached, with identical bytes', [fileResponse.status, fileResponse.headers.get('content-type'), fileResponse.headers.get('cache-control'), fileResponse.headers.get('content-disposition')?.includes('attachment'), Buffer.compare(Buffer.from(await fileResponse.arrayBuffer()), body)], [200, 'application/octet-stream', 'no-store', true, 0])
    // Receiving the last byte can precede FileHandle auto-close and pipeline's
    // finally. Keep the claim until that cleanup settles; wait for a read-only
    // list to prove availability before exercising another file request.
    let available = false
    for (let n = 0; n < 100; n++) {
      const idle = await fetch(`${base}/api/files/list?${new URLSearchParams({ ptyId: 'local', path: '' })}`, { headers })
      await idle.arrayBuffer()
      if (idle.status === 200) { available = true; break }
      if (idle.status !== 409) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check('download ownership lasts through cleanup and becomes available again', available, true)
    check('HTTP traversal is rejected', (await fetch(`${base}/api/files/download?${new URLSearchParams({ ptyId: 'local', path: '../outside/secret.txt' })}`, { headers })).status, 400)
    if (linked) check('HTTP also refuses a symlink escape', (await fetch(`${base}/api/files/download?${new URLSearchParams({ ptyId: 'local', path: 'escape/secret.txt' })}`, { headers })).status, 403)
    const sshListUrl = `${base}/api/files/list?ptyId=ssh`
    const disabled = await fetch(sshListUrl, { headers }); await disabled.arrayBuffer()
    check('HTTP SSH browsing stays off until a folder is configured', disabled.status, 403)
    configuredHost.downloadFolder = '~/fixture-project'
    const sshList = await fetch(sshListUrl, { headers })
    const remoteListing = await sshList.json() as { entries: { name: string }[] }
    check('the production HTTP route browses the SSH execution host', [sshList.status, remoteListing.entries?.[0]?.name], [200, 'remote.bin'])
    const sshDownload = await fetch(`${base}/api/files/download?ptyId=ssh&path=remote.bin`, { headers })
    check('the HTTP SSH attachment preserves all binary bytes', [sshDownload.status, sshDownload.headers.get('content-disposition')?.includes('attachment'), Buffer.compare(Buffer.from(await sshDownload.arrayBuffer()), body)], [200, true, 0])
    let sshAvailable = false
    for (let n = 0; n < 100; n++) {
      const ready = await fetch(sshListUrl, { headers }); await ready.arrayBuffer()
      if (ready.status === 200) { sshAvailable = true; break }
      if (ready.status !== 409) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check('HTTP SSH ownership lasts through spool cleanup', [sshAvailable, await readdir(sshRoot)], [true, []])
    const revoked = fetch(`${base}/api/files/download?ptyId=ssh&path=slow.bin`, { headers }).then((r) => r.status, () => 0)
    let childStarted = false
    for (let n = 0; n < 200; n++) {
      try { await readFile(started); childStarted = true; break } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
    }
    check('the revocation case reached an actual owned SSH subprocess', childStarted, true)
    configuredHost.downloadFolder = ''
    check('revoking the SSH folder cancels an active HTTP download before attachment headers', await revoked, 0)
    let released = false
    for (let n = 0; n < 100; n++) {
      const ready = await fetch(sshListUrl, { headers }); await ready.arrayBuffer()
      if (ready.status === 403) { released = true; break }
      if (ready.status !== 409) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check('revocation keeps ownership until actual child/spool cleanup finishes', [released, await readdir(sshRoot)], [true, []])
    const beforeCancel = (await readdir(root)).sort()
    const cancelledRequest = request(`${base}/api/files/upload?${new URLSearchParams({ ptyId: 'local', name: 'interrupt.txt', size: '10000' })}`, { method: 'POST', headers })
    cancelledRequest.on('error', () => {})
    cancelledRequest.write(Buffer.from('start'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    cancelledRequest.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    check('an interrupted real HTTP body removes its partial directory', (await readdir(root)).sort(), beforeCancel)
    sessions[0].exited = true
    check('an ended session cannot expose its working folder', (await fetch(`${base}/api/files/list?ptyId=local`, { headers })).status, 404)
  } finally { controller.abort(); await server?.stop(); await rm(work, { recursive: true, force: true }) }
}
