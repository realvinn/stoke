/**
 * Main's half of Find in a conversation: one find-bar request in, one answer
 * out. It decides WHICH transcript (the tab's own file for a local tab; the
 * host's newest conversation for an SSH tab, and only on the host's answer),
 * gets it, and hands the search to the worker host. Nothing here reads a file
 * or runs a pattern itself.
 *
 * Every dependency is passed in, so `verify:find` drives the consent rules, the
 * in-flight claim and the refusal sentences with fakes and no Electron. Relative
 * `.ts` imports and no parameter properties, for the same reason.
 */
import type { SshHost } from '../shared/types.ts'
import {
  compileFind,
  consentVerdict,
  parseFindRequest,
  type TranscriptFindRequest,
  type TranscriptFindResult
} from '../shared/transcriptFind.ts'
import { MAX_REMOTE_TRANSCRIPT_BYTES, isSafeSessionId } from './ssh.ts'
import type { RemoteRead } from './sshTranscript.ts'
import type { FindHostAnswer, FindWorkerRequest, FindWorkerSource } from './transcriptFindHost.ts'

/** A copy of a host's conversation this recent is searched again rather than fetched again. */
export const REMOTE_FRESH_MS = 15_000

export interface FinderDeps {
  /** The host a session runs on: main's own record first, then the tab's host id. */
  hostFor(sessionId: string, hostId: string | null): SshHost | null
  /** Record "Allow for this host" (`SshHost.transcriptFind`), and tell the renderer. */
  allowHost(hostId: string): void
  /** The tab's own transcript on this machine, or null. */
  localFile(sessionId: string): Promise<string | null>
  /** One BatchMode read of the host's newest conversation, into memory. */
  readRemote(host: SshHost): Promise<RemoteRead>
  /** Write a read to the cache under userData; the file, or null when it could not be written. */
  keepRemote(host: SshHost, sessionId: string, read: Extract<RemoteRead, { ok: true }>): string | null
  search(req: Omit<FindWorkerRequest, 'id'>): Promise<FindHostAnswer>
  now(): number
}

interface RemoteCopy {
  at: number
  kept: boolean
  remotePath: string
  source: FindWorkerSource
}

type CopyAnswer = { ok: true; copy: RemoteCopy } | { ok: false; why: 'ssh' | 'none' }

const hostName = (h: SshHost): string => h.label.trim() || h.alias.trim() || 'that machine'

export class ConversationFinder {
  private readonly deps: FinderDeps
  /** The last copy per (host, session), for `REMOTE_FRESH_MS`. */
  private copies = new Map<string, RemoteCopy>()
  /** One fetch per (host, session, kind) at a time: claimed before the first await (gotcha 20). */
  private inFlight = new Map<string, Promise<CopyAnswer>>()

  constructor(deps: FinderDeps) {
    this.deps = deps
  }

  async find(raw: unknown): Promise<TranscriptFindResult> {
    const req = parseFindRequest(raw)
    if (!req) return { ok: false, reason: 'failed', message: 'That was not a search.' }
    const compiled = compileFind(req.query, req)
    if (!compiled) return { ok: false, reason: 'bad-query', message: 'Nothing to find.' }
    if (!compiled.ok) return { ok: false, reason: 'bad-query', message: compiled.error }
    if (!req.sessionId) {
      return {
        ok: false,
        reason: 'no-session',
        message: 'Claude has not said which conversation this is yet, so only the screen is searched.'
      }
    }
    // It names a file (the local transcript, the remote copy's cache).
    if (!isSafeSessionId(req.sessionId)) return { ok: false, reason: 'failed', message: 'That is not a session.' }

    const host = this.deps.hostFor(req.sessionId, req.hostId)
    return host ? this.remote(req, host) : this.local(req)
  }

  private async local(req: TranscriptFindRequest): Promise<TranscriptFindResult> {
    const file = await this.deps.localFile(req.sessionId)
    if (!file) return { ok: false, reason: 'no-file', message: 'Claude has not written this conversation to disk yet.' }
    const answer = await this.deps.search(this.workerRequest(req, { kind: 'file', file }))
    if (!answer.ok) return this.failed(answer)
    const { partial, ...found } = answer.value
    return { ok: true, ...found, source: { kind: 'local', file, partial } }
  }

  private async remote(req: TranscriptFindRequest, host: SshHost): Promise<TranscriptFindResult> {
    const name = hostName(host)
    const verdict = consentVerdict(host, req.consent)
    if (verdict === 'ask') {
      return {
        ok: false,
        reason: 'consent',
        host: name,
        message: `Search this conversation? Stoke will copy the last 4 MB of the newest Claude conversation on ${name} to this computer over ssh.`
      }
    }
    // The press that allows the host also records it, before anything is fetched.
    if (req.consent === 'always' && host.transcriptFind !== true) this.deps.allowHost(host.id)

    const got = await this.copyFor(host, req.sessionId, verdict === 'keep', req.refresh === true)
    if (!got.ok) {
      return got.why === 'none'
        ? { ok: false, reason: 'no-remote', host: name, message: `${name} has no Claude conversation in ~/.claude/projects to search.` }
        : {
            ok: false,
            reason: 'fetch-failed',
            host: name,
            message: `Could not read ${name} without a prompt. Find copies the conversation with ssh in BatchMode, which needs key login.`
          }
    }
    const answer = await this.deps.search(this.workerRequest(req, got.copy.source))
    if (!answer.ok) return this.failed(answer)
    const { partial: _partial, ...found } = answer.value
    return {
      ok: true,
      ...found,
      source: {
        kind: 'ssh',
        host: name,
        remotePath: got.copy.remotePath,
        tailBytes: MAX_REMOTE_TRANSCRIPT_BYTES,
        fetchedAt: got.copy.at,
        kept: got.copy.kept
      }
    }
  }

  /**
   * A copy of the host's conversation: a recent one if there is one (a query
   * typed a letter at a time must not cost a round trip per letter), else one
   * fetch, shared by every request that arrives while it runs. A kept copy is
   * written under userData; a "Just this once" copy lives only in memory, and
   * a kept copy serves a once-request too (it is already on disk).
   */
  private copyFor(host: SshHost, sessionId: string, keep: boolean, refresh: boolean): Promise<CopyAnswer> {
    const key = `${host.id}\0${sessionId}`
    // A copy past its time is never searched again, so it is not held either:
    // "Just this once" leaves nothing behind for longer than one bar's typing.
    const now = this.deps.now()
    for (const [k, c] of this.copies) if (now - c.at >= REMOTE_FRESH_MS) this.copies.delete(k)
    const held = this.copies.get(key)
    if (held && !refresh && this.deps.now() - held.at < REMOTE_FRESH_MS && (held.kept || !keep)) {
      return Promise.resolve({ ok: true, copy: held })
    }
    const flightKey = `${key}\0${keep ? 'keep' : 'once'}`
    const running = this.inFlight.get(flightKey)
    if (running) return running
    const run = (async (): Promise<CopyAnswer> => {
      const read = await this.deps.readRemote(host)
      if (!read.ok) return { ok: false, why: read.why }
      const at = this.deps.now()
      const file = keep ? this.deps.keepRemote(host, sessionId, read) : null
      const copy: RemoteCopy = file
        ? { at, kept: true, remotePath: read.remotePath, source: { kind: 'file', file } }
        : { at, kept: false, remotePath: read.remotePath, source: { kind: 'text', key: `${key}\0${at}`, text: read.jsonl } }
      this.copies.set(key, copy)
      return { ok: true, copy }
    })().finally(() => this.inFlight.delete(flightKey))
    this.inFlight.set(flightKey, run)
    return run
  }

  /** Drop every copy held in memory, as the bar closing or quitting does. */
  forget(): void {
    this.copies.clear()
  }

  private workerRequest(req: TranscriptFindRequest, source: FindWorkerSource): Omit<FindWorkerRequest, 'id'> {
    return {
      query: req.query,
      caseSensitive: req.caseSensitive,
      wholeWord: req.wholeWord,
      regex: req.regex,
      includeTools: req.includeTools,
      source
    }
  }

  private failed(answer: Extract<FindHostAnswer, { ok: false }>): TranscriptFindResult {
    return answer.timeout
      ? { ok: false, reason: 'timeout', message: 'That pattern took too long to search with. Try a simpler one.' }
      : { ok: false, reason: 'failed', message: answer.error }
  }
}
