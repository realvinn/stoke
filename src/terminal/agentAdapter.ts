import crossSpawn from 'cross-spawn'
import { cliFor, type CodingCliId } from '../shared/codingClis.ts'

/** Ambiguous names such as grok/amp also belong to unrelated programs. Only
 * the vendor version fingerprint qualifies them as an agent. Version output
 * is bounded and checked before the session service receives a launch. */
export async function verifyAgentIdentity(id: CodingCliId, file: string): Promise<void> {
  const cli = cliFor(id)
  if (!cli.identify) return
  const pattern = cli.identify
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
    const child = crossSpawn(file, ['--version'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true; clearTimeout(timer)
      if (ok) resolve()
      else reject(new Error(`${file} did not identify as ${cli.label}. Install the agent from ${cli.home} or configure its executable path.`))
    }
    const timer = setTimeout(() => { child.kill(); finish(false) }, 3000)
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 128 * 1024) { child.kill(); finish(false) }
    })
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0 && pattern.test(output)))
  })
}
