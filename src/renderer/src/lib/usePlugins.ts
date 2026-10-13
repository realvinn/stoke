import { useEffect, useState } from 'react'
import type { PluginsView } from '@shared/pluginPackages'
/** Subscribe before pull and keep revisions monotonic across windows. */
export function usePlugins(): { view: PluginsView | null; error: string } {
  const [view, setView] = useState<PluginsView | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const accept = (next: PluginsView): void => {
      if (live) setView((old) => (!old || next.revision >= old.revision ? next : old))
    }
    const off = window.stoke.plugins.onChange(accept)
    window.stoke.plugins
      .read()
      .then(accept)
      .catch((error) => {
        if (live) setError(String(error))
      })
    return () => {
      live = false
      off()
    }
  }, [])
  return { view, error }
}
export function usePluginAppearance(): PluginsView | null {
  const { view } = usePlugins()
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.stokePluginAppearance = 'true'
    const tokens = Object.assign(
      {},
      ...(view?.entries.filter((entry) => entry.enabled).map((entry) => entry.manifest.appearance) ?? [])
    )
    style.textContent = `:root{${Object.entries(tokens)
      .map(([key, value]) => `${key}:${value}!important`)
      .join(';')}}`
    document.head.append(style)
    return () => style.remove()
  }, [view])
  return view
}
