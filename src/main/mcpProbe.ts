import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { validateMcpSetup, type McpProbeResult } from '../shared/mcpSetup.ts'
import type { McpServerSpec } from '../shared/mcpServers.ts'

async function executable(command: string, path: string): Promise<string> {
  if (isAbsolute(command) || /[/\\]/.test(command)) {
    if (!(await stat(command)).isFile()) throw Object.assign(new Error('missing executable'), { code: 'ENOENT' })
    return command
  }
  if (process.platform !== 'win32') return command
  const names = /\.[a-z]+$/i.test(command) ? [command] : [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
  for (const dir of path.split(delimiter).filter(Boolean).slice(0, 200)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (await access(candidate).then(() => true, () => false)) return candidate
    }
  }
  return command
}

/** A deliberate, short-lived initialize + tools/list. No tools are called. */
export async function probeMcp(value: unknown, path: string, timeoutMs = 8000): Promise<McpProbeResult> {
  const checked = validateMcpSetup(value)
  if (!checked.ok) return checked
  const spec: McpServerSpec = checked.spec
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let client: import('@modelcontextprotocol/sdk/client/index.js').Client | undefined
  let transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport | undefined
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    try {
      if (transport && 'terminateSession' in transport && typeof transport.terminateSession === 'function') await transport.terminateSession()
    } catch { /* some servers have no DELETE endpoint */ }
    try { await transport?.close() } catch { /* never echo server errors or stderr */ }
  }
  try {
    const work = async (): Promise<McpProbeResult> => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      if (abort.signal.aborted) throw new Error('probe expired')
      client = new Client({ name: 'stoke-connection-test', version: '1' }, { capabilities: {} })
      if (spec.transport === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        const env = { ...spec.env }
        let serverPath = path
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === 'path') { serverPath = env[key]; delete env[key] }
        }
        env.PATH = serverPath
        const command = await executable(spec.command, serverPath)
        if (abort.signal.aborted) throw new Error('probe expired')
        const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
        // A batch shim is cmd.exe, so refuse shell syntax rather than reinterpret a literal argument.
        if (batch && /[&|<>^%!\r\n]/.test([command, ...spec.args].join(' '))) return { ok: false, message: 'This Windows batch shim cannot safely test these arguments. Use the server’s executable or its JavaScript entry point with node.' }
        transport = new StdioClientTransport({ command: batch ? process.env.COMSPEC || 'cmd.exe' : command,
          args: batch ? ['/c', command, ...spec.args] : spec.args, env, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 })
      } else {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        if (abort.signal.aborted) throw new Error('probe expired')
        const headers = { ...spec.headers }
        if (spec.bearer) headers.Authorization = `Bearer ${spec.bearer}`
        transport = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers },
          fetch: async (url, options) => {
            const response = await fetch(url, { ...options, signal: closing ? AbortSignal.timeout(1000) : abort.signal, redirect: 'error' })
            if (!response.body) return response
            let bytes = 0
            const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
              bytes += chunk.byteLength
              if (bytes > 2 * 1024 * 1024) { controller.error(new Error('MCP connection-test response is too large')); abort.abort() }
              else controller.enqueue(chunk)
            } }))
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
          } })
      }
      await client.connect(transport, { signal: abort.signal, timeout: timeoutMs })
      const identity = client.getServerVersion()
      const listing = client.getServerCapabilities()?.tools ? await client.listTools({}, { signal: abort.signal, timeout: timeoutMs }) : null
      // A server can echo our token even in its identity. Only return a narrow version, masked against every supplied value.
      const version = identity?.version ?? ''
      const values = [...Object.values(spec.env), ...Object.values(spec.headers), spec.bearer ?? ''].filter(Boolean)
      const safeVersion = version.length <= 80 && /^v?\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version) && !values.some((value) => version.includes(value))
      return { ok: true, server: spec.name, version: safeVersion ? version : 'unknown', tools: listing?.tools.length ?? 0, moreTools: !!listing?.nextCursor }
    }
    return await Promise.race([work(), new Promise<McpProbeResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort()
        resolve({ ok: false, message: 'The server did not finish its connection test in time. Check its command, credentials and network.' })
      }, timeoutMs)
    })])
  } catch (error) {
    const err = error as { name?: string; code?: string | number }
    if (err.name === 'UnauthorizedError' || err.code === 401 || err.code === 403) return { ok: false, message: 'The server needs authentication. Check the token or headers, or sign in through the agent’s own MCP flow.' }
    if (err.code === 'ENOENT') return { ok: false, message: 'The executable was not found. Check its name or enter its full path.' }
    return { ok: false, message: 'The server could not complete MCP initialization or list its tools. Check its transport, command and credentials.' }
  } finally {
    clearTimeout(timer)
    abort.abort()
    await close()
  }
}
