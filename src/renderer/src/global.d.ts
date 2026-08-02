import type { StokeApi } from '@shared/api'

declare global {
  interface Window {
    stoke: StokeApi
  }
}

export {}
