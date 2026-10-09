import type { CodingCliId } from './codingClis.ts'

export interface LaunchPreflightRequest {
  cwd: string
  cli: CodingCliId
  accountId?: string
}
export interface LaunchPreflightItem {
  id: 'folder' | 'cli' | 'account' | 'provider' | 'tools'
  label: string
  state: 'configured' | 'warning' | 'blocked'
  message: string
}
export interface LaunchPreflightReport {
  cwd: string
  cli: CodingCliId
  checkedAt: number
  items: LaunchPreflightItem[]
}
export type LaunchPreflightResult = { ok: true; report: LaunchPreflightReport } | { ok: false; message: string }
