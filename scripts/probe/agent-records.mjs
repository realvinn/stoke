/** A PID can belong to another CLI later, or to another run of the same CLI.
 * Journals are append-only, so every complete start line begins a new epoch.
 * Never let an earlier process's launch or events stand in for a later one. */
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'

export function parseAgentRecords(file, source) {
  const name = /^([a-z]+)-(\d+)\.jsonl$/.exec(file)
  if (!name) return []
  const records = []
  let current = null
  const lines = source.split('\n')
  // A concurrent append may be visible before its final newline arrives.
  // Defer that line until it is complete instead of accepting a partial epoch.
  lines.pop()
  for (const [startIndex, line] of lines.entries()) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { throw new Error(`Malformed probe journal ${file}:${startIndex + 1}`) }
    if (!event || typeof event.kind !== 'string') throw new Error(`Invalid probe event ${file}:${startIndex + 1}`)
    if (event.kind === 'start') {
      if (!Array.isArray(event.argv) || typeof event.cwd !== 'string' || !event.env || typeof event.env !== 'object') throw new Error(`Invalid probe start ${file}:${startIndex + 1}`)
      current = { file, id: name[1], pid: Number(name[2]), startIndex, key: JSON.stringify([file, startIndex]), start: event, events: [event] }
      records.push(current)
    } else if (current) {
      current.events.push(event)
      if (event.kind === 'exit') current = null
    }
  }
  return records
}

export function readAgentRecords(directory, id) {
  return readdirSync(directory).flatMap(file => {
    if (!/^([a-z]+)-(\d+)\.jsonl$/.test(file) || (id && !file.startsWith(`${id}-`))) return []
    return parseAgentRecords(file, readFileSync(join(directory, file), 'utf8'))
  }).sort((a, b) => Number(a.start.t ?? 0) - Number(b.start.t ?? 0) || a.file.localeCompare(b.file) || a.startIndex - b.startIndex)
}

function canonicalCwd(cwd) {
  try {
    const actual = realpathSync.native(cwd)
    return process.platform === 'win32' ? actual.toLowerCase() : actual
  } catch {
    // Retained Windows artifacts can also be replayed on another host.
    return /^[a-z]:[\\/]/i.test(cwd) ? win32.normalize(cwd).toLowerCase() : resolve(cwd)
  }
}

/** Always require the expected CLI, plus PID and launch folder when known.
 * File order, not wall time, decides an epoch within a reused-PID journal. */
export function selectAgentRecord(records, id, pid, cwd) {
  if (!id || (pid !== undefined && !Number.isSafeInteger(pid))) return null
  const expectedCwd = cwd === undefined ? null : canonicalCwd(cwd)
  const epochs = new Map()
  for (const record of records) {
    if (record.id !== id || (pid !== undefined && record.pid !== pid) || (expectedCwd !== null && canonicalCwd(record.start.cwd) !== expectedCwd)) continue
    const previous = epochs.get(record.file)
    if (!previous || record.startIndex > previous.startIndex) epochs.set(record.file, record)
  }
  return [...epochs.values()].sort((a, b) => Number(a.start.t ?? 0) - Number(b.start.t ?? 0) || a.file.localeCompare(b.file)).at(-1) ?? null
}
