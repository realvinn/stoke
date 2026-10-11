import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { GBOT_VERSION } from '../../shared/grokBot.ts'
const INTEGRITY = 'RAFBqDnCV+tuNpmB8Hs3NmP8/2pewCXFdmDpbLZ46h8a98VIalRXewasqoU3N28itRgyHbBSkFyU3HgG5DAFMQ=='
const CLI_HASH = '70ed28198daa2a204a649760e01fb60688d27f9aaac66de372e39ea0351a0cdd'
const WORKER_HASH = '5e2211f62cd7501ba36f45ef1fc6577f91804f2daf77054d7308759261ff5441'
const MAX_ARCHIVE = 12 * 1024 * 1024
/** A pinned, integrity-checked artifact. No npm lifecycle or upstream installers. */
export class GrokBotRuntime {
  private root: string
  private pending: Promise<string> | null = null
  private controller: AbortController | null = null
  constructor(root: string) {
    this.root = join(root, 'runtime', 'grok-bot', GBOT_VERSION)
  }
  private get path(): string {
    return join(this.root, 'gbot.mjs')
  }
  async installed(): Promise<boolean> {
    let file: Awaited<ReturnType<typeof open>> | null = null
    try {
      file = await open(this.path, 'r')
      const info = await file.stat()
      if (!info.isFile() || info.size > 20 * 1024 * 1024) return false
      if (
        createHash('sha256')
          .update(await file.readFile())
          .digest('hex') !== CLI_HASH
      )
        return false
      await file.close()
      file = await open(join(this.root, 'gbot-flight.mjs'), 'r')
      const workerInfo = await file.stat()
      if (!workerInfo.isFile() || workerInfo.size > 20 * 1024 * 1024) return false
      return (
        createHash('sha256')
          .update(await file.readFile())
          .digest('hex') === WORKER_HASH
      )
    } catch {
      return false
    } finally {
      await file?.close()
    }
  }
  async ready(): Promise<string> {
    if (!(await this.installed())) throw new Error('Install the reviewed Grok Bot CLI first.')
    return this.path
  }
  stop(): void {
    this.controller?.abort()
  }
  install(): Promise<string> {
    if (this.pending) return this.pending
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    const timer = setTimeout(() => controller.abort(), 60_000)
    const run = this.download(signal).finally(() => {
      clearTimeout(timer)
      if (this.pending === run) {
        this.pending = null
        this.controller = null
      }
    })
    this.pending = run
    return run
  }
  private async download(signal: AbortSignal): Promise<string> {
    if (await this.installed()) {
      signal.throwIfAborted()
      return this.path
    }
    const response = await fetch(
      `https://registry.npmjs.org/grok-bot-cli/-/grok-bot-cli-${GBOT_VERSION}.tgz`,
      { signal, redirect: 'error' }
    )
    if (!response.ok || !response.body) throw new Error('The pinned CLI download failed. Try again later.')
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > MAX_ARCHIVE) {
        await response.body.cancel().catch(() => {})
        throw new Error('The CLI archive exceeded its limit.')
      }
      chunks.push(chunk)
    }
    signal.throwIfAborted()
    const archive = Buffer.concat(chunks)
    if (createHash('sha512').update(archive).digest('base64') !== INTEGRITY)
      throw new Error('The CLI download failed its integrity check. Nothing was installed.')
    const tar = await promisify(gunzip)(archive, { maxOutputLength: 32 * 1024 * 1024 })
    signal.throwIfAborted()
    const assets = new Map<string, Buffer>()
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) break
      const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
      const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim()
      if (!/^[0-7]+$/.test(sizeText)) throw new Error('The CLI archive is malformed.')
      const length = parseInt(sizeText, 8),
        start = offset + 512
      if (start + length > tar.length) throw new Error('The CLI archive is truncated.')
      if (
        ['package/dist/bin/gbot.mjs', 'package/dist/bin/gbot-flight.mjs', 'package/LICENSE'].includes(name)
      ) {
        if (![0, 48].includes(header[156]) || assets.has(name))
          throw new Error('The CLI archive contains an unsupported asset.')
        assets.set(name, tar.subarray(start, start + length))
      }
      offset = start + Math.ceil(length / 512) * 512
    }
    const worker = assets.get('package/dist/bin/gbot-flight.mjs')
    const cli = assets.get('package/dist/bin/gbot.mjs'),
      license = assets.get('package/LICENSE')
    if (
      !cli ||
      !worker ||
      !license ||
      createHash('sha256').update(worker).digest('hex') !== WORKER_HASH ||
      createHash('sha256').update(cli).digest('hex') !== CLI_HASH
    )
      throw new Error('The CLI archive is missing the reviewed files.')
    const stage = `${this.root}.${randomUUID()}.tmp`
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      await writeFile(join(stage, 'gbot.mjs'), cli, { mode: 0o600, signal })
      await writeFile(join(stage, 'gbot-flight.mjs'), worker, { mode: 0o600, signal })
      await writeFile(join(stage, 'LICENSE'), license, { mode: 0o600, signal })
      signal.throwIfAborted()
      await rm(this.root, { recursive: true, force: true })
      signal.throwIfAborted()
      await rename(stage, this.root)
      return this.path
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
    }
  }
}
