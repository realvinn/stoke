/*
 * Extractor quality against real pages, asserted rather than eyeballed.
 *
 * Every extractor bug found so far produced plausible-looking output rather
 * than an error, so a typecheck proves nothing here and reading a sample by eye
 * proves little more. These three pages each broke it in a different way and
 * are kept as the regression set.
 *
 * Stoke must already be running. It writes its MCP endpoint and bearer token to
 * mcp-browser.json under its user-data directory:
 *
 *   node scripts/verify-extract.mjs [path-to-mcp-browser.json]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cfgPath =
  process.argv[2] || join(process.env.APPDATA || homedir(), 'Stoke', 'mcp-browser.json')

let cfg
try {
  cfg = JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers.stoke
} catch (err) {
  console.error(`Could not read ${cfgPath}\nIs Stoke running? (${err.message})`)
  process.exit(2)
}

let id = 0
async function rpc(method, params, notify = false) {
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: ++id, method, params }
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...cfg.headers
    },
    body: JSON.stringify(body)
  })
  const raw = await res.text()
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          return JSON.parse(line.slice(5).trim())
        } catch {
          /* keep scanning the stream */
        }
      }
    }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r?.error) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 200)}`)
  const c = r?.result?.content?.[0]
  return c?.type === 'text' ? c.text : `[${c?.type}]`
}

/*
 * Each case states what the page is *for*, so a failure says what broke rather
 * than which assertion tripped. `lines` are matched against whole output lines:
 * chrome leaks as its own line, and substring matching would false-positive on
 * the same words appearing inside legitimate prose.
 */
const CASES = [
  {
    url: 'https://code.claude.com/docs/en/remote-control',
    what: 'documentation — prose surrounded by heavy nav chrome',
    forbidLines: ['Copy page', 'iOS', 'Android', 'Ask AI', 'Search...', 'Navigation'],
    requireText: ['Remote Control'],
    minChars: 1500,
    minHeadings: 3
  },
  {
    url: 'https://news.ycombinator.com',
    what: 'aggregator — whole page built from layout tables, content is links',
    forbidLines: [],
    requireText: ['points'],
    minChars: 2000,
    minHeadings: 0,
    // The failure that matters here is losing the headlines entirely.
    minLinks: 25
  },
  {
    url: 'https://en.wikipedia.org/wiki/Pseudoterminal',
    what: 'article — the case that already worked, guarding against regression',
    forbidLines: ['Jump to content', 'Donate', 'Create account', 'Personal tools'],
    requireText: ['pseudoterminal', 'master'],
    minChars: 4000,
    minHeadings: 5
  }
]

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'verify-extract', version: '1' }
})
await rpc('notifications/initialized', {}, true)

let failures = 0

for (const c of CASES) {
  console.log(`\n${'='.repeat(72)}\n${c.url}\n  ${c.what}\n${'='.repeat(72)}`)
  await call('browser_open', { url: c.url })

  const read = await call('browser_read', { full: false, maxChars: 60000 })
  const markdown = read.split('\n').slice(3).join('\n')
  const outline = await call('browser_outline', {})
  const headings = outline.split('\n').filter((l) => /^\s*\d+[.:]|^\s*#{1,6}\s|\S/.test(l) && l.trim())

  const problems = []

  for (const bad of c.forbidLines) {
    const hit = markdown.split('\n').find((l) => l.trim() === bad)
    if (hit !== undefined) problems.push(`chrome leaked as its own line: "${bad}"`)
  }
  for (const want of c.requireText) {
    if (!markdown.toLowerCase().includes(want.toLowerCase())) {
      problems.push(`missing expected content: "${want}"`)
    }
  }
  if (markdown.length < c.minChars) {
    problems.push(`only ${markdown.length} chars of markdown, expected >= ${c.minChars}`)
  }
  const headingCount = headings.length - 1 // first line is the tool's own header
  if (headingCount < c.minHeadings) {
    problems.push(`only ${headingCount} headings in outline, expected >= ${c.minHeadings}`)
  }
  if (c.minLinks) {
    const links = (markdown.match(/\]\(/g) || []).length
    if (links < c.minLinks) {
      problems.push(`only ${links} links kept, expected >= ${c.minLinks}`)
    }
  }

  const links = (markdown.match(/\]\(/g) || []).length
  console.log(`  ${markdown.length} chars · ${headingCount} headings · ${links} links`)
  console.log('  ---- first 12 lines ----')
  for (const line of markdown.split('\n').filter(Boolean).slice(0, 12)) {
    console.log(`  | ${line.slice(0, 110)}`)
  }

  if (problems.length) {
    failures += problems.length
    console.log('  FAIL')
    for (const p of problems) console.log(`    - ${p}`)
  } else {
    console.log('  PASS')
  }
}

console.log(`\n${failures ? `${failures} problem(s)` : 'all pages pass'}`)
process.exit(failures ? 1 : 0)
