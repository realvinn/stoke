import type { IPty } from '@lydell/node-pty'

/**
 * Call only from onExit, after node-pty has drained its final output.
 * @lydell/node-pty 1.2.0-beta.14 leaves its input pipe and ConPTY worker
 * referenced after a natural Windows exit. Its public destroy() kills a
 * process; it is unsafe to call that after exit, when the PID may be reused.
 * Release only the two transports owned by this exact terminal object.
 * Recheck this narrow compatibility shim when updating node-pty.
 */
export function releaseExitedPtyTransports(child: IPty): void {
  if (process.platform !== 'win32') return
  const agent = (child as IPty & { _agent?: {
    _inSocket?: { destroy: () => void }
    _conoutSocketWorker?: { dispose: () => void }
  } })._agent
  try { agent?._inSocket?.destroy() } catch { /* already closed */ }
  try { agent?._conoutSocketWorker?.dispose() } catch { /* already disposed */ }
}
