/** A bounded read that still honours its owner's cancellation on older browsers. */
export function requestDeadline(parent: AbortSignal | null | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const cancel = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) cancel()
  else parent?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('The computer did not answer in time.')), timeoutMs)
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', cancel) } }
}
