/**
 * Find in a conversation's worker thread: it reads the transcript and runs the
 * user's pattern, and nothing else. Built as its own bundle (`?modulePath` in
 * index.ts) and started by `TranscriptFindHost` on the first search.
 *
 * A thread of its own rather than the chat index's, on purpose: the pattern is
 * typed by the user, a regex can backtrack for minutes, and the only cure is to
 * terminate the thread running it. Killing the chat worker would also kill a
 * running index pass or import; killing this one costs one parse cache.
 */
import { parentPort } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { compileFind, searchBlocks } from '../shared/transcriptFind.ts'
import { BlockCache } from './transcriptFind.ts'
import type { FindWorkerReply, FindWorkerRequest } from './transcriptFindHost.ts'

const port = parentPort
if (!port) throw new Error('transcript-find worker started outside a worker thread')

const cache = new BlockCache()

port.on('message', (req: FindWorkerRequest) => {
  let reply: FindWorkerReply
  try {
    const compiled = compileFind(req.query, req)
    if (!compiled || !compiled.ok) {
      reply = { id: req.id, ok: false, error: compiled ? compiled.error : 'Nothing to find.' }
    } else {
      const read =
        req.source.kind === 'file'
          ? cache.forFile(req.source.file, req.includeTools, statSync(req.source.file))
          : cache.forText(req.source.key, req.source.text, req.includeTools)
      // A literal query's own spelling is the match a hit offers to copy.
      const prefer = req.regex ? null : req.query
      reply = { id: req.id, ok: true, value: { ...searchBlocks(read.blocks, compiled.re, {}, prefer), partial: read.partial } }
    }
  } catch (err) {
    reply = { id: req.id, ok: false, error: (err as Error).message || 'The search failed.' }
  }
  port.postMessage(reply)
})
