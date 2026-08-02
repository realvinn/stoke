import type { HearthApi } from '@shared/api'

declare global {
  interface Window {
    hearth: HearthApi
  }
}

export {}
