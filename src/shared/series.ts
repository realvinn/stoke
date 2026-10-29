import type { Appearance } from './ladder.ts'

/** Chart series are distinct from semantic warning and status colours. */
export const SERIES_SEEDS: Record<Appearance, readonly [string, string, string, string]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500']
}
