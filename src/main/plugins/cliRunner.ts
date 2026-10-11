/** Child-only Node preload. Main-module CLI execution follows after this returns.
 * Bounded synchronous stdin is intentional here: this dedicated child must finish
 * preparing argv before Node starts the CLI; Electron's UI never imports it.
 */
import { readSync } from 'node:fs'
import { isMainThread } from 'node:worker_threads'
if (isMainThread) {
  try {
    const chunks: Buffer[] = []
    let size = 0
    for (;;) {
      const chunk = Buffer.alloc(8192),
        length = readSync(0, chunk, 0, chunk.length, null)
      if (!length) break
      size += length
      if (size > 256 * 1024) throw new Error()
      chunks.push(chunk.subarray(0, length))
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      !('argv' in value) ||
      !Array.isArray(value.argv) ||
      value.argv.some((arg) => typeof arg !== 'string' || arg.length > 64 * 1024)
    )
      throw new Error()
    process.argv = [process.execPath, process.argv[1], ...value.argv]
  } catch {
    process.stderr.write('The CLI input could not be read.\n')
    process.exit(1)
  }
}
