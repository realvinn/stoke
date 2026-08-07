import { readTranscript, type TranscriptTurn } from '../sessionFile.ts'
import { runHeadless, type HeadlessOptions } from '../agent.ts'
import { asRecord, candidates, clip, oneLine } from './json.ts'
import { EMPTY_RECALL, formatRecall, statusesFor, type RecallSnapshot } from './recall.ts'
import { DEFAULT_WORKLOG_BOARDS, WORKLOG_TARGETS } from '../../shared/worklog.ts'
import type { ProposalDraft } from './queue.ts'
import type { WorklogBoards, WorklogKind, WorklogProposal, WorklogTarget } from '@shared/types'

/**
 * The worklog agent itself: read one session back, propose entries, and — only
 * when told to — write them.
 *
 * Two hard constraints shape everything here, both settled by measurement rather
 * than taste (PLAN.md, "Worklog execution"):
 *
 *  - **Cost.** The probe that proved this works cost $0.50 for one trivial
 *    prompt, because it defaulted to Opus against a large cached context. A run
 *    per session at that price costs more than the feature saves. So the scan
 *    sends a *digest* of the transcript, never the transcript, runs on Sonnet,
 *    and loads nothing else — no CLAUDE.md, no skills, no MCP servers.
 *  - **Blast radius.** The scan is read-only by construction rather than by
 *    instruction: no MCP config at all, and the tools that could touch the
 *    machine explicitly denied. Writing is a separate call the user has to make,
 *    with exactly one write tool allowed per run.
 *
 * Nothing in this file touches electron, so scripts/verify-worklog-runner.mts
 * can exercise the prompt building and the parsing under plain node.
 */

/* ------------------------------------------------------------- destinations */

/**
 * The shipped defaults, kept as named exports because other modules import
 * them. The live values come from `Settings.worklogBoards`: an id is one
 * person's board, and compiling it in meant nobody else could use the feature
 * and this machine could not narrow to one destination.
 *
 * The default Notion data source's schema already matches what is written
 * here, and the default ClickUp list is the engineering list — deliberately not
 * the Team Space's `IT Support Tasks`, which is a helpdesk queue whose statuses
 * would make engineering work unreadable.
 */
export const NOTION_DATA_SOURCE = DEFAULT_WORKLOG_BOARDS.notionDataSource
export const CLICKUP_LIST_ID = DEFAULT_WORKLOG_BOARDS.clickupListId

/**
 * The write tools, by what the proposal does and where it does it.
 *
 * An update to ClickUp gets two, and that pairing is deliberate:
 * `clickup_update_task` *replaces* a description, so writing the note through it
 * would delete whatever the task already said. The note goes on as a comment and
 * only the status moves. Notion's update-page appends, so one tool is enough
 * there.
 */
const WRITE_TOOLS: Record<WorklogKind, Record<WorklogTarget, string[]>> = {
  create: {
    clickup: ['mcp__claude_ai_ClickUp__clickup_create_task'],
    notion: ['mcp__claude_ai_Notion__notion-create-pages']
  },
  update: {
    clickup: [
      'mcp__claude_ai_ClickUp__clickup_update_task',
      'mcp__claude_ai_ClickUp__clickup_create_comment'
    ],
    notion: ['mcp__claude_ai_Notion__notion-update-page']
  }
}

/** A proposal written before updates existed has no kind, and creates. */
export function kindOf(proposal: Pick<WorklogProposal, 'kind'>): WorklogKind {
  return proposal.kind === 'update' ? 'update' : 'create'
}

/**
 * ClickUp first, always.
 *
 * If the second write fails the first is already done and its URL already
 * stored, so the user sees a half-filed proposal rather than losing the write
 * that succeeded. ClickUp leads because an actionable task is the half worth
 * keeping.
 */
export const WRITE_ORDER: WorklogTarget[] = ['clickup', 'notion']

/* -------------------------------------------------------------- scan limits */

/** Turns pulled off the transcript before summarising. */
export const TRANSCRIPT_TURNS = 400

/** Whole-digest ceiling. Roughly 1.5k tokens — the point is that it is bounded. */
export const MAX_DIGEST_CHARS = 6000

/** The opening turns, which is where the ask usually is. */
const HEAD_TURNS = 3
/** The closing turns, which is where the outcome is. */
const TAIL_TURNS = 40
const MAX_TURN_CHARS = 320
const MAX_TOOLS_PER_TURN = 6

/**
 * Tools the scan may not use.
 *
 * The scan needs no tools at all — it is handed a transcript Stoke has already
 * read off disk — so this is belt and braces on top of `--strict-mcp-config`
 * with an empty config. Bash/Edit/Write/Task are the blast radius; WebFetch and
 * WebSearch are that plus an unbounded bill. Read/Glob/Grep are denied for the
 * cost reason alone: given a working directory, a model that decides to go and
 * look at the repo turns a fixed-price run into an open-ended one.
 */
export const SCAN_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
  'WebFetch',
  'WebSearch',
  'Read',
  'Glob',
  'Grep'
]

/* ------------------------------------------------------------------ errors */

/**
 * The model's reply could not be read as proposals.
 *
 * Its own type because the one thing that must never happen is a parse failure
 * looking like "this session had nothing worth logging". Those two outcomes are
 * indistinguishable from the outside and one of them is a silent feature death.
 */
export class WorklogParseError extends Error {
  readonly reply: string

  constructor(message: string, reply: string) {
    super(message)
    this.name = 'WorklogParseError'
    this.reply = reply
  }
}

/* ------------------------------------------------------------- the digest */

/** `Read, Edit x3` — counts matter (three edits is different work from one). */
function toolSummary(tools: string[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1)
  const parts: string[] = []
  for (const [name, n] of counts) {
    if (parts.length >= MAX_TOOLS_PER_TURN) {
      parts.push('…')
      break
    }
    parts.push(n > 1 ? `${name} x${n}` : name)
  }
  return parts.join(', ')
}

function turnLine(turn: TranscriptTurn): string {
  const who = turn.role === 'user' ? 'user' : 'claude'
  const text = clip(oneLine(turn.text), MAX_TURN_CHARS)
  const tools = turn.tools.length ? ` [tools: ${toolSummary(turn.tools)}]` : ''
  return `${who}: ${text}${tools}`
}

/**
 * A bounded, readable digest of a session.
 *
 * Keeps the opening turns and the closing ones and elides the middle, because
 * those are the two halves of the question being asked: what was this for, and
 * where did it end up. The character cap is enforced afterwards by dropping
 * further turns from the *older* end, so the most recent state always survives.
 */
export function summariseTurns(turns: TranscriptTurn[]): string {
  if (!turns.length) return ''

  const head = turns.slice(0, HEAD_TURNS)
  const tailStart = Math.max(head.length, turns.length - TAIL_TURNS)
  const tail = turns.slice(tailStart)

  const headLines = head.map(turnLine)
  const tailLines = tail.map(turnLine)
  let elided = turns.length - head.length - tail.length

  const size = (): number =>
    headLines.concat(tailLines).reduce((n, l) => n + l.length + 1, 0) + (elided ? 40 : 0)

  while (size() > MAX_DIGEST_CHARS && tailLines.length > 1) {
    tailLines.shift()
    elided++
  }

  const parts = [...headLines]
  if (elided > 0) parts.push(`… (${elided} turn${elided === 1 ? '' : 's'} elided) …`)
  parts.push(...tailLines)
  return clip(parts.join('\n'), MAX_DIGEST_CHARS)
}

/* ---------------------------------------------------------------- titles */

/**
 * How long a title may be. Short enough to read at a glance in a ClickUp list,
 * long enough to name the actual thing rather than gesture at it.
 */
export const MAX_TITLE_CHARS = 72

/**
 * The house style, in one place, so the prompt and the tidier cannot disagree.
 *
 * From the user, verbatim: titles should be "simple and laymens terms but not so
 * simple it makes it sounds useless … like Added [Feature] or Fixed [Bug] …
 * with more details in the actual page". So: a verb, then the thing, in words
 * someone who was not in the session would use.
 */
export const TITLE_RULES = [
  '- Start with what was done: Added, Fixed, Updated, Removed, Sped up, Documented.',
  '- Then name the actual thing, plainly: "Added SSH sessions to the launcher", not',
  '  "Added a feature" (says nothing) and not "feat(cli): buildSshArgs" (jargon).',
  `- Under ${MAX_TITLE_CHARS} characters. No file or function names, no markdown, no full stop.`,
  '- The detail goes in the body. The title is the headline, not the report.'
]

/** Conventional-commit and changelog prefixes, which are exactly what to avoid. */
const COMMIT_PREFIX = /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]*\))?!?:\s*/i

/**
 * Mechanically fix what the wording alone does not.
 *
 * Prompt rules move the average; they do not stop the one reply in ten that
 * arrives as "**fix(worklog):** dedupe key." — and a title is the only part of a
 * proposal the user reads before deciding, so it is the part worth normalising
 * in code. Everything here is removal: nothing invents words the model did not
 * write.
 */
export function tidyTitle(raw: string): string {
  let t = oneLine(raw ?? '')
  // Markdown first: a bold or heading marker would otherwise hide the commit
  // prefix behind it and survive the strip below.
  t = t.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '')
  t = t.replace(/\*\*/g, '').replace(/`/g, '').replace(/^_+|_+$/g, '')
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  t = t.replace(COMMIT_PREFIX, '')
  t = t.replace(/\s*[.。]+$/, '').trim()
  if (!t) return ''

  if (t.length > MAX_TITLE_CHARS) {
    // Cut at a word boundary. A title chopped mid-word reads as a bug in Stoke
    // rather than a long title, and it is the first thing the user sees.
    const cut = t.slice(0, MAX_TITLE_CHARS)
    const space = cut.lastIndexOf(' ')
    t = `${(space > MAX_TITLE_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}…`
  }

  return t.charAt(0).toUpperCase() + t.slice(1)
}

/* ------------------------------------------------------------- the prompts */

export interface ScanContext {
  sessionId: string
  cwd: string
  group: string
  /** Claude Code's own title for the session, when it produced one. */
  title?: string | null
  digest: string
  /**
   * What the boards already hold, rendered by `formatRecall`. Empty when recall
   * found nothing or could not run.
   */
  existing?: string
  /**
   * True when recall failed rather than came back empty.
   *
   * The distinction is the whole reason this flag exists: told nothing, the
   * model reasonably assumes the boards are empty and proposes a create for
   * everything, which is precisely the duplication recall was added to stop. It
   * has to know the difference between "nothing there" and "could not look".
   */
  recallFailed?: boolean
}

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

/**
 * The scan prompt. Small on purpose — see the cost note at the top of the file.
 *
 * The reply format is spelled out twice (shape, then example) because the parser
 * has to be defensive anyway and every prose sentence the model adds is a chance
 * for it to be wrong.
 */
export function buildScanPrompt(ctx: ScanContext): string {
  const existing = (ctx.existing ?? '').trim()

  return [
    'You are a work-log assistant for a software developer. Below is a compressed',
    'record of one Claude Code session. Turn it into task-tracker entries.',
    '',
    `Project: ${projectName(ctx.cwd)} (group: ${ctx.group || 'unknown'})`,
    `Session: ${ctx.sessionId}`,
    ctx.title ? `Session title: ${oneLine(ctx.title)}` : '',
    '',
    '<<<SESSION',
    ctx.digest,
    'SESSION',
    '',
    // What is already tracked. Ahead of the instructions on purpose: the model
    // has to have read it before it is asked to decide create-or-update.
    existing
      ? ['Already on the boards:', '', existing, ''].join('\n')
      : ctx.recallFailed
        ? [
            'The boards could not be read this time, so you do not know what is already',
            'tracked. Propose creates only, and keep them to work that is clearly new.',
            ''
          ].join('\n')
        : ['The boards are empty — nothing is tracked yet.', ''].join('\n'),
    'Produce:',
    '1. One summary entry: {"kind":"create","targets":["notion"]}. Body: what was worked',
    '   on, what changed, what was decided. Past tense, 2-5 sentences.',
    '2. For every item above this session moved on - finished, started or blocked - one',
    '   {"kind":"update"} naming its board and its id. Never a second record for work',
    '   that already has one.',
    '3. One {"kind":"create","targets":["clickup"]} per outstanding item NOT listed above:',
    '   unfinished, deferred, broken, or named as next. Body says what to do and why.',
    '',
    // The model tends to return the summary alone, which is half the feature
    // missing and looks like a complete answer. This paragraph pushes against
    // that. Honest note: across four measured runs of one real session it did
    // not by itself change the count, so it is a nudge, not a fix — if the
    // ClickUp half stays thin in use, the digest is the next thing to look at,
    // not the wording.
    'Work through the record for kinds 2 and 3 before deciding there are none: most',
    'sessions leave something deferred, unfixed, unverified, or named as next.',
    '',
    'Titles are read by someone who was not there:',
    ...TITLE_RULES,
    '',
    'Rules:',
    '- At most 6 entries. Bodies at most 600 characters, plain text, no markdown.',
    '- An update names one board and one id, copied exactly from the list above. Its',
    '  "status" must be one shown there, or left out.',
    '- Invent nothing. If the record does not say it, it did not happen; if an id is',
    '  not listed above, it does not exist.',
    '- If there is nothing worth logging, reply with exactly: []',
    '',
    'Reply with a JSON array and nothing else - no prose, no code fence. Example:',
    '[{"kind":"create","title":"Added SSH sessions to the launcher","body":"...","targets":["notion"]},',
    ' {"kind":"update","target":"clickup","id":"abc123","status":"complete","title":"Finished the SSH work","body":"..."}]'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** The write prompt for one destination. One item, one URL back. */
export function buildApplyPrompt(
  proposal: WorklogProposal,
  target: WorklogTarget,
  boards: WorklogBoards = DEFAULT_WORKLOG_BOARDS
): string {
  const shared = [
    `Title: ${oneLine(proposal.title)}`,
    `Project: ${projectName(proposal.cwd)}`,
    'Body:',
    proposal.body.trim(),
    ''
  ]

  if (kindOf(proposal) === 'update') {
    const existing = proposal.existing?.[target]
    const status = proposal.newStatus?.[target]

    /*
     * An update with no id is not an update.
     *
     * scanSession demotes those to creates before they ever reach the queue, so
     * arriving here means a hand-edited or migrated record. Writing a create
     * instead would be a guess that files a duplicate into a real board, so the
     * prompt refuses out loud and the run comes back as an error the panel can
     * show.
     */
    if (!existing?.id) {
      return [
        'Do nothing and change nothing.',
        '',
        'Reply with JSON and nothing else: {"error":"this update names no record to change"}'
      ].join('\n')
    }

    const destination =
      target === 'clickup'
        ? [
            `Update ONE existing ClickUp task, id ${existing.id} ("${oneLine(existing.title)}").`,
            status
              ? `Set its status to exactly "${status}" with clickup_update_task, changing nothing else.`
              : 'Do not change its status.',
            // The note is a comment because clickup_update_task's description
            // field replaces rather than appends, and the description is where
            // the original ask lives.
            'Then add the body below as a comment with clickup_create_comment.',
            'Do not touch the name, the description, the assignee or the due date.'
          ]
        : [
            `Update ONE existing Notion page, id ${existing.id} ("${oneLine(existing.title)}").`,
            status ? `Set its status property to exactly "${status}".` : 'Do not change its status.',
            'Append the body below to the end of the page with notion-update-page.',
            'Do not change the title and do not replace any existing content.'
          ]

    return [
      ...destination,
      '',
      ...shared,
      'Change exactly this one record. Do not search first, do not create anything, and',
      'do not modify anything else.',
      '',
      'When it is done, reply with JSON and nothing else, holding the record\'s URL:',
      '{"url":"https://..."}'
    ].join('\n')
  }

  const destination =
    target === 'clickup'
      ? [
          'Create ONE task in ClickUp using clickup_create_task.',
          `List id: ${boards.clickupListId}. Use the title as the task name and the body as`,
          'its description. Set no assignee, no due date and no custom fields.'
        ]
      : [
          'Create ONE page in Notion using notion-create-pages.',
          `Parent data source: ${boards.notionDataSource}. Use the title as the page title`,
          'and the body as the page content. Set no other properties.'
        ]

  return [
    ...destination,
    '',
    ...shared,
    'Create exactly one item. Do not search first, do not create anything else, and',
    'do not modify anything that already exists.',
    '',
    'When it is created, reply with JSON and nothing else, holding the new item\'s',
    'URL: {"url":"https://..."}'
  ].join('\n')
}

/* -------------------------------------------------------------- the parsing */

/** What the model is asked for; the scan adds the session fields around it. */
export interface ModelProposal {
  title: string
  body: string
  targets: WorklogTarget[]
  kind: WorklogKind
  /**
   * For an update: the destination and the id it named. Unverified at this
   * point — `scanSession` is what checks the id against what recall actually
   * saw, because only it has the snapshot.
   */
  target?: WorklogTarget
  existingId?: string
  newStatus?: string
}

const TARGETS: WorklogTarget[] = [...WORKLOG_TARGETS]

function normaliseTargets(v: unknown): WorklogTarget[] {
  if (!Array.isArray(v)) return [...TARGETS]
  const picked = v.filter((t): t is WorklogTarget => TARGETS.includes(t as WorklogTarget))
  // An unrecognised destination is dropped rather than guessed at, and a
  // proposal with none left falls back to both: the user reviews it either way,
  // and nothing is written until they do.
  return picked.length ? [...new Set(picked)] : [...TARGETS]
}

/**
 * Turn one parsed JSON value into proposals, or explain why it is not.
 *
 * Returns null rather than throwing so the caller can try the next candidate
 * shape: a reply reading "I found [3] things: [{...}]" yields a balanced `[3]`
 * before it yields the real list, and giving up on the first bracket would fail
 * a perfectly good reply.
 */
function toProposals(value: unknown): { proposals: ModelProposal[] } | { reason: string } {
  let entries: unknown[]
  const record = asRecord(value)
  if (Array.isArray(value)) {
    entries = value
  } else if (record && Array.isArray(record.proposals)) {
    entries = record.proposals
  } else if (record && Array.isArray(record.entries)) {
    entries = record.entries
  } else if (record && typeof record.title === 'string') {
    entries = [record]
  } else {
    return { reason: 'the JSON is not a list of proposals' }
  }

  const proposals: ModelProposal[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = asRecord(entries[i])
    // Loud rather than lenient. Dropping the unreadable entry and keeping the
    // rest would file a partial worklog that looks complete.
    if (!entry) return { reason: `proposal ${i + 1} is not an object` }
    const title = tidyTitle(typeof entry.title === 'string' ? entry.title : '')
    if (!title) return { reason: `proposal ${i + 1} has no usable title` }

    const target = TARGETS.includes(entry.target as WorklogTarget)
      ? (entry.target as WorklogTarget)
      : null
    const existingId = typeof entry.id === 'string' ? entry.id.trim() : ''
    /*
     * An update is only an update when it says which record.
     *
     * `kind:"update"` with no board or no id names nothing that could be
     * changed, so honouring the word alone would queue a write with no address.
     * Reading it as a create is the recoverable half: the user still sees the
     * entry and still decides, and `scanSession` applies the same demotion when
     * the id turns out not to exist.
     */
    const kind: WorklogKind = entry.kind === 'update' && target && existingId ? 'update' : 'create'
    const status = typeof entry.status === 'string' ? oneLine(entry.status).trim() : ''

    const proposal: ModelProposal = {
      title,
      body: typeof entry.body === 'string' ? entry.body.trim() : '',
      // An update goes to exactly the one board that holds the record; asking
      // for it on both would address the other board's copy, which does not
      // exist.
      targets: kind === 'update' && target ? [target] : normaliseTargets(entry.targets),
      kind
    }
    if (kind === 'update' && target) {
      proposal.target = target
      proposal.existingId = existingId
      if (status) proposal.newStatus = clip(status, 60)
    }
    proposals.push(proposal)
  }
  return { proposals }
}

/**
 * Read proposals out of whatever the model replied with.
 *
 * Tolerates a code fence, prose either side, a `{"proposals": [...]}` wrapper
 * and a lone object. Does NOT tolerate a reply it cannot read: an empty list is
 * returned only when the model genuinely produced an empty list, because
 * "nothing to log" and "the parse failed" have to stay tellable apart.
 */
export function parseProposals(reply: string): ModelProposal[] {
  const text = (reply ?? '').trim()
  if (!text) throw new WorklogParseError('the model returned an empty reply', reply ?? '')

  // An explicit "nothing here" that is not JSON. Unambiguous, so it is honoured
  // rather than treated as a parse failure - unlike, say, "No proposals found",
  // which is prose that might be hiding a list further down.
  if (/^none[.!]?$/i.test(text)) return []

  let reason: string | null = null
  for (const candidate of candidates(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    const outcome = toProposals(value)
    if ('proposals' in outcome) return outcome.proposals
    // Keep the first complaint: it is about the shape the model most likely
    // meant, and the later candidates are fragments of it.
    reason ??= outcome.reason
  }

  throw new WorklogParseError(
    `${reason ?? "the model's reply held no readable JSON"}: ${clip(oneLine(text), 300)}`,
    reply
  )
}

/** The URL of the thing that was just created, from a write run's reply. */
export function parseWrittenUrl(reply: string, target: WorklogTarget): string | null {
  const text = (reply ?? '').trim()
  if (!text) return null
  for (const candidate of candidates(text)) {
    try {
      const record = asRecord(JSON.parse(candidate))
      const url = record?.url
      if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) return url.trim()
    } catch {
      /* fall through to the plain scan */
    }
  }
  /*
   * A loose scan for any URL is not good enough here. The reply routinely
   * mentions unrelated links - a doc it consulted, an example - and accepting
   * one of those marks the item written and files a dead link the user can only
   * discover by clicking it. Require the host to belong to the destination.
   */
  const host = HOST_FOR[target]
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    const url = m[0].replace(/[.,;]+$/, '')
    // No pattern for an unknown destination means no way to tell a real record
    // from an incidental link, so report nothing rather than guess.
    if (host?.test(url)) return url
  }
  return null
}

/** Hosts a created record can legitimately live on, per destination. */
const HOST_FOR: Record<WorklogTarget, RegExp> = {
  clickup: /^https?:\/\/(app\.)?clickup\.com\//i,
  notion: /^https?:\/\/([\w-]+\.)?notion\.(so|site)\//i
}

/* ---------------------------------------------------------------- the runs */

export interface ScanInput {
  sessionId: string
  cwd: string
  group: string
  /** Path to the session's own JSONL transcript. */
  transcriptFile: string
  title?: string | null
  claudePath?: string | null
  timeoutMs?: number
  maxBudgetUsd?: number
  /** What the boards already hold. Omitted means "could not look". */
  recall?: RecallSnapshot
  /** True when a scan the user did not ask for produced this. */
  auto?: boolean
}

export interface ScanOutcome {
  proposals: ProposalDraft[]
  costUsd: number | null
  /** Size of the prompt actually sent, which is the thing that costs money. */
  promptChars: number
  /** True when the transcript held no conversation to summarise. */
  emptyTranscript: boolean
  /**
   * Updates that named a record recall had never seen, and were therefore
   * written down as creates instead. Surfaced rather than swallowed: a steady
   * count here means recall is being truncated or the model is inventing ids,
   * and both look like "the feature works" from outside.
   */
  demoted: number
}

/**
 * The exact run a scan performs.
 *
 * Split out so the promises it makes — read-only, sonnet, budget-capped — can be
 * asserted against the real thing rather than a copy of it in a test. Every one
 * of them is a property that would regress silently.
 */
export function scanRunOptions(
  prompt: string,
  input: Pick<ScanInput, 'claudePath' | 'timeoutMs' | 'maxBudgetUsd'>
): HeadlessOptions {
  return {
    prompt,
    // No cwd: the run executes in a neutral scratch folder, so no project's
    // CLAUDE.md is discovered and paid for. It has the digest; it needs nothing
    // from the repository.
    strictMcp: true,
    safeMode: true,
    // Pinned, because thinking tokens bill as output and the machine's default
    // effort is expensive here. Measured on one real 146-turn session:
    // default 46s/$0.107, low 7.8s/$0.043, medium 7.4s/$0.043 and 6.6s/$0.035.
    // Medium rather than low only because there is no measured reason to prefer
    // low, and quality is the thing that cannot be checked from out here.
    effort: 'medium',
    disallowedTools: SCAN_DISALLOWED_TOOLS,
    timeoutMs: input.timeoutMs,
    maxBudgetUsd: input.maxBudgetUsd,
    claudePath: input.claudePath ?? null
  }
}

/**
 * The exact run one destination's write performs: one tool, and only one.
 *
 * Note the absence of `strictMcp` — a write needs the user's own claude.ai
 * connectors, which is precisely why the allowlist here has to be exact.
 */
export function applyRunOptions(
  proposal: WorklogProposal,
  target: WorklogTarget,
  opts: ApplyOptions = {}
): HeadlessOptions {
  return {
    prompt: buildApplyPrompt(proposal, target, opts.boards ?? DEFAULT_WORKLOG_BOARDS),
    // The project directory, because MCP servers can be configured per project.
    // runHeadless falls back to a scratch dir if it has since been deleted.
    cwd: proposal.cwd,
    allowedTools: [...WRITE_TOOLS[kindOf(proposal)][target]],
    effort: 'medium',
    timeoutMs: opts.timeoutMs,
    maxBudgetUsd: opts.maxBudgetUsd,
    claudePath: opts.claudePath ?? null
  }
}

/**
 * Read a session and propose entries for it. Writes nothing, anywhere.
 *
 * Throws on a failed run or an unreadable reply. An empty `proposals` means the
 * model looked and found nothing worth logging.
 */
export async function scanSession(input: ScanInput): Promise<ScanOutcome> {
  const transcript = await readTranscript(input.transcriptFile, TRANSCRIPT_TURNS)
  if (!transcript.turns.length) {
    return { proposals: [], costUsd: null, promptChars: 0, emptyTranscript: true, demoted: 0 }
  }

  const snapshot = input.recall ?? EMPTY_RECALL
  const prompt = buildScanPrompt({
    sessionId: input.sessionId,
    cwd: input.cwd,
    group: input.group,
    title: input.title ?? null,
    digest: summariseTurns(transcript.turns),
    existing: formatRecall(snapshot),
    // A snapshot that was never taken counts as failed: both mean the model was
    // not shown the boards, and only one of them may be reported as "empty".
    recallFailed: !!snapshot.error || snapshot.readAt === 0
  })

  const result = await runHeadless(scanRunOptions(prompt, input))

  if (result.isError) {
    throw new Error(`The worklog scan failed: ${clip(oneLine(result.text), 300) || result.subtype || 'unknown error'}`)
  }

  const { drafts, demoted } = groundProposals(parseProposals(result.text), input, snapshot)

  return {
    proposals: drafts,
    costUsd: result.costUsd,
    promptChars: prompt.length,
    emptyTranscript: false,
    demoted
  }
}

/**
 * Check every update against what recall actually saw, and turn the rest into
 * drafts.
 *
 * This is where a model's claim about the outside world stops being taken on
 * trust. Two checks, and both of them exist because the alternative is a write
 * that fails at somebody else's API with an error the user can do nothing
 * about:
 *
 *  - **The id must be one recall returned.** If it is not, the record either
 *    does not exist or is outside the window recall read, and in both cases
 *    there is nothing to address the update to. The entry is kept as a create,
 *    because the work it describes is real even when the id is not.
 *  - **The status must be one that destination already uses.** A model asked to
 *    close a task will offer "Done" to a board whose states are "open" and
 *    "complete". Dropping just the status leaves a note-only update, which is
 *    still worth writing.
 *
 * Exported so scripts/verify-worklog-runner.mts can exercise both without a
 * transcript or a live run.
 */
export function groundProposals(
  proposals: ModelProposal[],
  input: Pick<ScanInput, 'sessionId' | 'cwd' | 'group' | 'auto'>,
  snapshot: RecallSnapshot
): { drafts: ProposalDraft[]; demoted: number } {
  const drafts: ProposalDraft[] = []
  let demoted = 0

  for (const p of proposals) {
    const draft: ProposalDraft = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      group: input.group,
      title: p.title,
      body: p.body,
      targets: p.targets,
      kind: 'create'
    }
    if (input.auto) draft.auto = true

    const target = p.target
    const found =
      p.kind === 'update' && target && p.existingId
        ? (snapshot.items[target]?.find((i) => i.id.toLowerCase() === p.existingId!.toLowerCase()) ??
          null)
        : null

    if (p.kind === 'update' && !found) {
      demoted++
      // Fall through as a create, and drop the single-board narrowing that only
      // made sense while it was an update.
      draft.targets = [...(target ? [target] : TARGETS)]
      drafts.push(draft)
      continue
    }

    if (found && target) {
      draft.kind = 'update'
      draft.targets = [target]
      draft.existing = { [target]: found }
      const wanted = p.newStatus?.trim()
      if (wanted && statusesFor(snapshot, target).has(wanted.toLowerCase())) {
        draft.newStatus = { [target]: wanted }
      }
    }

    drafts.push(draft)
  }

  return { drafts, demoted }
}

export interface ApplyOptions {
  claudePath?: string | null
  /**
   * Which boards to write to, and their ids. Absent means the shipped
   * defaults — which is what every existing caller and test relies on.
   */
  boards?: WorklogBoards
  /**
   * Called the instant a destination answers, before the next one is attempted.
   * Persist here — that is what makes a half-succeeded accept visible instead of
   * lost.
   */
  onWritten?: (target: WorklogTarget, url: string | null) => void | Promise<void>
  timeoutMs?: number
  maxBudgetUsd?: number
  /**
   * Override the runner. Exists so the write path can be tested at all: every
   * real call here creates a record in a live Notion or ClickUp workspace, so
   * the retry and half-success behaviour cannot be exercised for real without
   * leaving rubbish behind in the user's own tools.
   */
  run?: typeof runHeadless
}

export interface ApplyOutcome {
  urls: Partial<Record<WorklogTarget, string>>
  errors: Partial<Record<WorklogTarget, string>>
  costUsd: number | null
  ok: boolean
}

/**
 * Write an accepted proposal to its destinations. The only code path in the
 * feature that changes anything outside Stoke.
 *
 * One run per destination, each with exactly one write tool allowed — the
 * narrowest allowlist there is, and narrower than one run with both. A failure
 * on the second destination cannot undo or hide the first, because the first has
 * already been reported through `onWritten`.
 */
export async function applyProposal(
  proposal: WorklogProposal,
  opts: ApplyOptions = {}
): Promise<ApplyOutcome> {
  const urls: Partial<Record<WorklogTarget, string>> = {}
  const errors: Partial<Record<WorklogTarget, string>> = {}
  let cost: number | null = null

  /*
   * A destination the user has switched off is not written, however the
   * proposal is addressed. A proposal can outlive the setting that produced it
   * — it sits in the queue until someone reviews it — so the check belongs
   * here, at the only point that changes anything outside Stoke.
   *
   * Absent `opts.boards` falls back to the shipped default (Notion only), not
   * to every known target — an unconfigured install must never write to
   * ClickUp by accident.
   */
  const allowed = opts.boards ? opts.boards.targets : DEFAULT_WORKLOG_BOARDS.targets
  const wanted = proposal.targets.filter((t) => allowed.includes(t))
  if (!wanted.length) {
    /*
     * Loud, not silent. Returning an empty success would mark the proposal
     * accepted with nothing written anywhere, which is the exact class of
     * failure this feature already had too much of. The error is keyed on the
     * destination the proposal *asked* for, because that is the one the panel
     * will name.
     */
    const named = proposal.targets[0] ?? 'notion'
    return {
      urls: {},
      errors: {
        [named]:
          'no board is switched on for this entry — turn one on under Settings, Worklog agent'
      },
      costUsd: null,
      ok: false
    }
  }

  for (const target of WRITE_ORDER) {
    if (!wanted.includes(target)) continue

    /*
     * Never write a destination this proposal already reached.
     *
     * The whole reason writes are ordered and reported one at a time is that a
     * half-success survives: ClickUp created, Notion failed, the URL persisted.
     * The panel then offers Try again, and without this guard the retry would
     * create a SECOND ClickUp task while fixing the Notion one - silently
     * duplicating a real record in a real workspace, which no error would ever
     * surface. Carry the existing URL through so the outcome still reports it.
     */
    const already = proposal.urls?.[target]
    if (already !== undefined) {
      urls[target] = already
      continue
    }

    try {
      const result = await (opts.run ?? runHeadless)(applyRunOptions(proposal, target, opts))
      if (result.costUsd !== null) cost = (cost ?? 0) + result.costUsd

      if (result.isError) {
        throw new Error(clip(oneLine(result.text), 300) || result.subtype || 'the run reported an error')
      }

      /*
       * An update already had a URL before the run started: the record exists,
       * that is the whole point of it being an update. So a reply without a
       * link is not "written, no link" — the link is known, and showing it is
       * strictly better than showing nothing.
       */
      const url = parseWrittenUrl(result.text, target) ?? proposal.existing?.[target]?.url ?? null
      if (url) {
        urls[target] = url
      } else {
        /*
         * Mark the destination reached even without a link.
         *
         * The run succeeded, so a record very probably exists. Leaving this
         * unset made the guard above see nothing on a retry, and the panel
         * offers Try again on a failed item - so the retry created a SECOND
         * real task while "fixing" the missing link. An empty string records
         * "written, no link"; the panel renders links truthily, so it shows
         * nothing rather than a broken one.
         */
        urls[target] = ''
        // Deliberately not silent: the run succeeded, so something may well have
        // been created, and the user needs to know to go and look.
        errors[target] = 'the run finished but returned no URL, so the item could not be linked'
      }
      await opts.onWritten?.(target, url)
    } catch (err) {
      errors[target] = err instanceof Error ? err.message : String(err)
      // Keep going. The whole point of the ordering is that one destination
      // failing does not cost the other one.
    }
  }

  return { urls, errors, costUsd: cost, ok: Object.keys(errors).length === 0 && Object.keys(urls).length > 0 }
}
