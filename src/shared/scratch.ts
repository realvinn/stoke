export interface ScratchSettings {
  directory: string | null
  /** Upgrades keep the existing app-data scratch root until explicitly changed. */
  legacyLocation: boolean
  autoName: boolean
}
export const DEFAULT_SCRATCH: ScratchSettings = { directory: null, legacyLocation: false, autoName: false }
export function hydrateScratch(raw: unknown, existing: boolean): ScratchSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<ScratchSettings> : null
  return {
    directory: typeof value?.directory === 'string' && value.directory.trim() ? value.directory.trim() : null,
    legacyLocation: value ? value.legacyLocation === true : existing,
    autoName: value?.autoName === true
  }
}
export function scratchLabel(prompt: string): string {
  return prompt.replace(/<[^>]*>/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64)
}
