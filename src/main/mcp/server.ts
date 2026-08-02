import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { EmbeddedBrowser } from '../browser.ts'
import { PageAgent } from './page.ts'
import { analyseDesign } from './design.ts'
import { detectStack } from './stack.ts'
import { auditSecurity } from './audit.ts'
import { analysePerformance } from './perf.ts'

/**
 * An MCP server exposing the docked browser to Claude Code.
 *
 * Stoke launches the CLI itself, so the config is injected at spawn time with
 * --mcp-config: no setup, and the tools are scoped to Stoke's sessions rather
 * than being installed globally.
 *
 * Bound to 127.0.0.1 on an ephemeral port behind a per-run bearer token. The
 * token matters: anything on the machine could otherwise POST to this port and
 * drive a browser holding the user's logged-in sessions.
 */

interface ReadResult {
  url?: string
  title?: string
  markdown?: string
  truncated?: boolean
  totalChars?: number
  outline?: { index: number; level: number; text: string }[]
  heading?: string
  error?: string
}

interface SnapshotResult {
  url: string
  title: string
  elements: {
    ref: string
    role: string
    name: string
    href?: string
    value?: string
    options?: string[]
    disabled?: boolean
    checked?: boolean
    y: number
  }[]
}

const text = (body: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text' as const, text: body }]
})

/** Rough token estimate so the agent can decide whether to read or skim. */
function tokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export class BrowserMcpServer {
  private http: Server | null = null
  private readonly token = randomBytes(24).toString('hex')
  private port = 0
  private readonly agent: PageAgent
  private readonly browser: EmbeddedBrowser

  constructor(browser: EmbeddedBrowser) {
    this.browser = browser
    this.agent = new PageAgent(browser)
  }

  /** Path of the config file handed to `claude --mcp-config`. */
  configPath(): string {
    return join(app.getPath('userData'), 'mcp-browser.json')
  }

  async start(): Promise<string> {
    if (this.http) return this.configPath()

    const server = createServer((req, res) => void this.handle(req, res))
    this.http = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Port 0 asks the OS for a free port; loopback only.
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0

    const config = {
      mcpServers: {
        stoke: {
          type: 'http',
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${this.token}` }
        }
      }
    }
    // A file rather than a JSON string on the command line: quoting a JSON
    // blob through a shell differs across platforms and breaks silently.
    writeFileSync(this.configPath(), JSON.stringify(config, null, 2), 'utf8')
    return this.configPath()
  }

  stop(): void {
    this.http?.close()
    this.http = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    let body: unknown
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json' }))
        return
      }
    }

    // Stateless: a fresh server and transport per request. The tools close over
    // the browser, so there is no per-session state worth keeping alive.
    const mcp = this.buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })

    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  private buildServer(): McpServer {
    const mcp = new McpServer({ name: 'stoke-browser', version: '1.0.0' })
    const agent = this.agent

    /* ------------------------------------------------------------ reading */

    mcp.registerTool(
      'browser_open',
      {
        title: 'Open a page',
        description:
          'Navigate the docked browser to a URL and wait for it to settle. Returns the ' +
          'page title, a heading outline and a size estimate — call browser_read to get ' +
          'the content itself. This is the same browser the user sees, and it carries ' +
          'their logged-in sessions.',
        inputSchema: { url: z.string().describe('URL, hostname, or localhost:port') }
      },
      async ({ url }) => {
        await agent.open(url)
        await agent.mark()
        const page = (await agent.read({ maxChars: 1 })) as ReadResult
        const outline = page.outline ?? []
        return text(
          [
            `Opened ${page.url}`,
            `Title: ${page.title}`,
            `Content: ~${tokens(page.totalChars ?? 0)} tokens`,
            outline.length ? '\nOutline:' : '\n(no headings found)',
            ...outline
              .slice(0, 40)
              .map((h) => `  [${h.index}] ${'  '.repeat(Math.max(0, h.level - 1))}${h.text}`)
          ].join('\n')
        )
      }
    )

    mcp.registerTool(
      'browser_read',
      {
        title: 'Read the page',
        description:
          'Read the current page as markdown, with headings, lists, tables and code ' +
          'blocks preserved and navigation/ads stripped. Prefer `section` (from the ' +
          'outline) or `ref` on a large page rather than reading the whole thing.',
        inputSchema: {
          section: z.number().optional().describe('Heading index from the outline'),
          ref: z.string().optional().describe('Read only within this element ref'),
          full: z.boolean().optional().describe('Include page chrome, not just main content'),
          maxChars: z.number().optional().describe('Truncate after this many characters')
        }
      },
      async ({ section, ref, full, maxChars }) => {
        const page = (await agent.read({ section, ref, full, maxChars })) as ReadResult
        if (page.error) return { ...text(page.error), isError: true }
        await agent.mark()

        const header = [
          `# ${page.title ?? ''}`.trim(),
          page.url ?? '',
          page.heading ? `Section: ${page.heading}` : '',
          page.truncated
            ? `(truncated — ${tokens(page.totalChars ?? 0)} tokens total; read a section instead)`
            : ''
        ]
          .filter(Boolean)
          .join('\n')

        return text(`${header}\n\n${page.markdown ?? ''}`)
      }
    )

    mcp.registerTool(
      'browser_outline',
      {
        title: 'Page outline',
        description:
          'List the page headings with their indices, for deciding which section to read. ' +
          'Cheap — use it before reading anything large.',
        inputSchema: {}
      },
      async () => {
        const heads = (await agent.outline()) as { index: number; level: number; text: string }[]
        if (!heads.length) return text('No headings on this page.')
        return text(
          heads
            .map((h) => `[${h.index}] ${'  '.repeat(Math.max(0, h.level - 1))}${h.text}`)
            .join('\n')
        )
      }
    )

    mcp.registerTool(
      'browser_find',
      {
        title: 'Find text on the page',
        description:
          'Search the visible page text and return matching passages with the heading they ' +
          'sit under and the nearest clickable ref. Much cheaper than reading a whole page ' +
          'to answer one question.',
        inputSchema: {
          query: z.string().describe('Text to search for (case-insensitive)'),
          limit: z.number().optional()
        }
      },
      async ({ query, limit }) => {
        const hits = (await agent.find(query, limit)) as {
          text: string
          heading: string | null
          ref: string | null
        }[]
        if (!hits.length) return text(`No matches for "${query}".`)
        return text(
          hits
            .map(
              (h, i) =>
                `${i + 1}. ${h.heading ? `[${h.heading}] ` : ''}${h.text}${h.ref ? `  (ref=${h.ref})` : ''}`
            )
            .join('\n')
        )
      }
    )

    mcp.registerTool(
      'browser_snapshot',
      {
        title: 'List interactive elements',
        description:
          'List every visible link, button and form control with a short ref. Act on those ' +
          'refs with browser_click / browser_type — never a CSS selector. Refs are ' +
          'invalidated by navigation, so re-snapshot after the page changes.',
        inputSchema: { limit: z.number().optional().describe('Max elements (default 200)') }
      },
      async ({ limit }) => {
        const snap = (await agent.snapshot(limit)) as SnapshotResult
        if (!snap.elements.length) return text('No interactive elements found.')
        const lines = snap.elements.map((e) => {
          const bits = [`${e.ref}`, e.role, e.name ? JSON.stringify(e.name) : '""']
          if (e.value) bits.push(`value=${JSON.stringify(e.value)}`)
          if (e.options) bits.push(`options=[${e.options.slice(0, 8).join('|')}]`)
          if (e.href) bits.push(`-> ${e.href}`)
          if (e.disabled) bits.push('(disabled)')
          if (e.checked) bits.push('(checked)')
          return bits.join(' ')
        })
        return text(`${snap.title}\n${snap.url}\n\n${lines.join('\n')}`)
      }
    )

    /* -------------------------------------------------------- interaction */

    const afterAction = async (label: string): Promise<ReturnType<typeof text>> => {
      const diff = await agent.changes()
      const parts = [label]
      if (diff.navigated) parts.push(`Navigated to ${diff.url} — ${diff.title}`)
      if (diff.added.length) {
        parts.push(`\nNew content (${diff.added.length} lines):`)
        parts.push(diff.added.slice(0, 60).join('\n'))
      }
      if (diff.removed.length) {
        parts.push(`\nRemoved ${diff.removed.length} lines.`)
      }
      if (!diff.added.length && !diff.removed.length) parts.push('Page content did not change.')
      return text(parts.join('\n'))
    }

    mcp.registerTool(
      'browser_click',
      {
        title: 'Click an element',
        description:
          'Click the element with this ref (from browser_snapshot), then report only what ' +
          'changed on the page rather than re-sending all of it.',
        inputSchema: { ref: z.string().describe('Element ref such as e12') }
      },
      async ({ ref }) => {
        await agent.mark()
        const label = await agent.click(ref)
        return afterAction(`Clicked ${label}.`)
      }
    )

    mcp.registerTool(
      'browser_type',
      {
        title: 'Type into a field',
        description:
          'Focus a text field by ref and set its value, firing the events that React and ' +
          'Vue need. Set submit to press Enter afterwards.',
        inputSchema: {
          ref: z.string(),
          text: z.string(),
          submit: z.boolean().optional().describe('Press Enter after typing')
        }
      },
      async ({ ref, text: value, submit }) => {
        await agent.mark()
        const label = await agent.type(ref, value, submit ?? false)
        return afterAction(`Typed into ${label}.`)
      }
    )

    mcp.registerTool(
      'browser_select',
      {
        title: 'Choose a dropdown option',
        description: 'Set the value of a <select> by ref.',
        inputSchema: { ref: z.string(), value: z.string() }
      },
      async ({ ref, value }) => {
        await agent.mark()
        const label = await agent.select(ref, value)
        return afterAction(`Selected ${JSON.stringify(value)} in ${label}.`)
      }
    )

    mcp.registerTool(
      'browser_scroll',
      {
        title: 'Scroll the page',
        description: 'Scroll the page, or bring a specific ref into view.',
        inputSchema: {
          to: z.enum(['top', 'bottom', 'up', 'down']).optional(),
          ref: z.string().optional()
        }
      },
      async ({ to, ref }) => {
        await agent.scroll(to ?? 'down', ref)
        return text('Scrolled.')
      }
    )

    mcp.registerTool(
      'browser_history',
      {
        title: 'Back, forward or reload',
        description: 'Move through the docked browser history, or reload the current page.',
        inputSchema: { action: z.enum(['back', 'forward', 'reload']) }
      },
      async ({ action }) => {
        await agent.mark()
        await agent.history(action)
        return afterAction(`Performed ${action}.`)
      }
    )

    mcp.registerTool(
      'browser_changes',
      {
        title: 'What changed',
        description:
          'Report what changed on the page since the last read or action, without ' +
          're-sending the whole page. Useful after waiting for something to load.',
        inputSchema: {}
      },
      async () => afterAction('Current differences:')
    )

    /* ------------------------------------------------------- diagnostics */

    mcp.registerTool(
      'browser_inspect',
      {
        title: 'Console and network',
        description:
          'Recent console messages and network requests for the current page. Use ' +
          'onlyProblems to see just errors, warnings and non-2xx responses — the fast way ' +
          'to find why a local app is misbehaving.',
        inputSchema: {
          kind: z.enum(['console', 'network', 'both']).optional(),
          onlyProblems: z.boolean().optional(),
          limit: z.number().optional()
        }
      },
      async ({ kind, onlyProblems, limit }) => {
        const max = limit ?? 40
        const want = kind ?? 'both'
        const out: string[] = []

        if (want !== 'network') {
          let entries = this.browser.consoleEntries()
          if (onlyProblems) entries = entries.filter((e) => /error|warn/i.test(e.level))
          out.push(`Console (${entries.length}):`)
          out.push(
            entries.length
              ? entries
                  .slice(-max)
                  .map((e) => `  [${e.level}] ${e.message}${e.source ? `  (${e.source})` : ''}`)
                  .join('\n')
              : '  (empty)'
          )
        }

        if (want !== 'console') {
          let entries = this.browser.networkEntries()
          if (onlyProblems) {
            entries = entries.filter((e) => e.error || (e.status !== null && e.status >= 400))
          }
          out.push(`\nNetwork (${entries.length}):`)
          out.push(
            entries.length
              ? entries
                  .slice(-max)
                  .map((e) => `  ${e.status ?? 'ERR'} ${e.method} ${e.url}${e.error ? ` — ${e.error}` : ''}`)
                  .join('\n')
              : '  (empty)'
          )
        }

        return text(out.join('\n'))
      }
    )

    mcp.registerTool(
      'browser_screenshot',
      {
        title: 'Screenshot the page',
        description:
          'Capture the page, or just one element via ref. Prefer browser_read for text — ' +
          'a screenshot costs far more tokens and reads text less reliably. Use it for ' +
          'layout, styling and visual bugs.',
        inputSchema: { ref: z.string().optional().describe('Capture only this element') }
      },
      async ({ ref }) => {
        const shot = await agent.screenshot(ref)
        return {
          content: [
            {
              type: 'image' as const,
              data: shot.base64,
              mimeType: 'image/png'
            }
          ]
        }
      }
    )

    /* ------------------------------------------------------------ analysis */

    mcp.registerTool(
      'browser_design',
      {
        title: 'Read the page as a design',
        description:
          "Extract the page's design system from what is actually rendered: the type " +
          'scale, ink and surface palettes with usage share, the spacing scale and every ' +
          'value that drifts off it, radii, shadows, layout mode, z-layers, declared ' +
          'breakpoints, and every text run that fails contrast. Reports both WCAG 2 ratio ' +
          'and APCA lightness contrast, because they disagree on dark and near-black pairs. ' +
          'Use this instead of a screenshot when the question is about styling, consistency ' +
          'or accessibility — it is far cheaper and far more precise.',
        inputSchema: {
          limit: z.number().optional().describe('Entries per section (default 12)'),
          contrastDetail: z
            .boolean()
            .optional()
            .describe('List up to 40 contrast failures rather than 12')
        }
      },
      async ({ limit, contrastDetail }) => {
        await agent.waitForStable()
        return text(await analyseDesign(agent.webContents(), { limit, contrastDetail }))
      }
    )

    mcp.registerTool(
      'browser_stack',
      {
        title: 'Identify the tech stack',
        description:
          'Report what the page is built with — framework, meta-framework, build tool, CSS ' +
          'approach, CMS, hosting, CDN, analytics — from runtime globals the framework ' +
          'installs, DOM markers, build output paths and response headers. Works on a local ' +
          'dev server as well as a public site, and reports current versions rather than ' +
          'matching against a signature database frozen in 2023.',
        inputSchema: {}
      },
      async () => {
        await agent.waitForStable()
        return text(await detectStack(agent.webContents(), this.browser.networkEntries()))
      }
    )

    mcp.registerTool(
      'browser_security',
      {
        title: 'Review the page for security hygiene',
        description:
          'Passive security review of the loaded page: CSP graded on strength rather than ' +
          'presence, HSTS, framing, cross-origin isolation, cookie flags, mixed content, ' +
          'subresource integrity, exposed source maps, development builds left live, and ' +
          'the third parties the page contacts. Reads only what the browser already ' +
          'received — it never probes paths, sends payloads, or makes a request the page ' +
          'did not make itself, so it is safe to point at any site. Reload the page first ' +
          'if response headers have not been captured yet.',
        inputSchema: {}
      },
      async () => {
        await agent.waitForStable()
        return text(await auditSecurity(agent.webContents(), this.browser.networkEntries()))
      }
    )

    mcp.registerTool(
      'browser_perf',
      {
        title: 'Measure why the page is slow',
        description:
          'Core Web Vitals with verdicts (LCP and its element, CLS and what shifted, FCP, ' +
          'TTFB, TBT), request weight by type, the heaviest resources, unused JS and CSS ' +
          'bytes, render-blocking resources, oversized and unsized images, font-display ' +
          'problems, DOM size and third-party cost. Reloads with the cache disabled by ' +
          'default, because unused-byte coverage is only meaningful when tracking starts ' +
          'before the bytes arrive.',
        inputSchema: {
          reload: z
            .boolean()
            .optional()
            .describe('Reload to measure a cold load (default true). False keeps the current page.')
        }
      },
      async ({ reload }) => {
        await agent.waitForStable()
        return text(await analysePerformance(agent.webContents(), { reload }))
      }
    )

    return mcp
  }
}
