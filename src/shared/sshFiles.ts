import type { PhoneFileListing } from './remoteFiles.ts'

export interface SshFilesRequest { requestId: string; hostId: string; path: string }
export type SshFilesListResult = { ok: true; listing: PhoneFileListing } | { ok: false; message: string }
export type SshFilesSaveResult = { ok: true; saved: boolean } | { ok: false; message: string }
export interface SshFilesProgress { requestId: string; received: number; size: number }
