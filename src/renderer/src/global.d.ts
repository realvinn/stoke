import type { StokeApi } from '@shared/api'

declare global {
  interface Window {
    stoke: StokeApi
    stokeQuickTerminal: import('@shared/quickTerminal').QuickTerminalApi
  }
}

export {}
