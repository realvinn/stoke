import type { Tab, TabWindowPacket, TabWindowTransfer } from '../shared/tabWindows.ts'
import { canMoveTab } from '../shared/tabWindows.ts'

/** Ownership is claimed before a window loads, then committed only after its renderer accepts. */
export class TabWindowState {
  readonly tabs = new Map<number, Tab[]>()
  readonly pending = new Map<string, { source: number; target: number; transfer: TabWindowTransfer }>()

  publish(windowId: number, raw: unknown): boolean {
    if (!Array.isArray(raw) || raw.length > 256) return false
    if (!raw.every(t => t && typeof t === 'object' && typeof t.id === 'string' && t.id.length <= 200 && typeof t.ptyId === 'string' && typeof t.sessionId === 'string')) return false
    const ids = new Set(raw.map(t => t.id))
    if (ids.size !== raw.length) return false
    for (const [id, tabs] of this.tabs) if (id !== windowId && tabs.some(t => ids.has(t.id))) return false
    this.tabs.set(windowId, raw as Tab[])
    return true
  }

  stage(id: string, source: number, target: number, packet: TabWindowPacket): boolean {
    if (!packet || !Array.isArray(packet.tabs) || !packet.tabs.length || packet.tabs.length > 256 || source === target || this.pending.has(id)) return false
    if ([...this.pending.values()].some(p => p.source === source)) return false
    if (!packet.stored || !Array.isArray(packet.stored.ids) || !packet.stored.state || packet.stored.state.version !== 1 || !Array.isArray(packet.stored.state.tabs) || packet.stored.ids.length !== packet.stored.state.tabs.length || packet.stored.ids.length > packet.tabs.length) return false
    if (!packet.screens || typeof packet.screens !== 'object' || !packet.contexts || typeof packet.contexts !== 'object' || !packet.drafts || typeof packet.drafts !== 'object') return false
    if (Object.values(packet.screens).some(screen => typeof screen !== 'string' || screen.length > 2_000_000)) return false
    const owned = this.tabs.get(source) ?? []
    const ids = new Set<string>()
    for (const tab of packet.tabs) {
      const current = owned.find(t => t.id === tab?.id)
      if (!current || !canMoveTab(current) || current.ptyId !== tab.ptyId || current.sessionId !== tab.sessionId || ids.has(tab.id)) return false
      if ([...this.pending.values()].some(p => p.transfer.packet.tabs.some(t => t.id === tab.id))) return false
      ids.add(tab.id)
    }
    this.pending.set(id, { source, target, transfer: { id, packet } })
    return true
  }

  accept(id: string, target: number): { source: number; ids: string[] } | null {
    const pending = this.pending.get(id)
    if (!pending || pending.target !== target) return null
    const sourceTabs = this.tabs.get(pending.source)
    if (!sourceTabs) { this.pending.delete(id); return null }
    const moved = pending.transfer.packet.tabs
    if (moved.some(t => !sourceTabs.some(s => s.id === t.id && s.ptyId === t.ptyId))) { this.pending.delete(id); return null }
    const ids = moved.map(t => t.id)
    this.tabs.set(pending.source, sourceTabs.filter(t => !ids.includes(t.id)))
    this.tabs.set(target, [...(this.tabs.get(target) ?? []), ...moved])
    this.pending.delete(id)
    return { source: pending.source, ids }
  }

  remove(windowId: number): void {
    this.tabs.delete(windowId)
    for (const [id, pending] of this.pending) if (pending.source === windowId || pending.target === windowId) this.pending.delete(id)
  }
}
