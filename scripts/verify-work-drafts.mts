import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkPlugin } from '../src/main/plugins/work.ts'
import { WorkDrafts, workDraftOptions } from '../src/main/plugins/workDrafts.ts'
import { buildHeadlessArgs, runHeadless } from '../src/main/agent.ts'
import type { HeadlessOptions, HeadlessResult } from '../src/main/agent.ts'
import type { WorkDraftRequest } from '../src/shared/workDrafts.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const okay = JSON.stringify(actual) === JSON.stringify(expected)
  if (!okay) failures++
  console.log(`  ${okay ? 'PASS' : 'FAIL'} ${name}${okay ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
const root = await mkdtemp(join(tmpdir(), 'stoke-drafts-'))
const work = new WorkPlugin(root)
const day = '2026-10-09'
const result = (text: string): HeadlessResult => ({ text, isError: false, subtype: 'success', costUsd: 0.02, durationMs: 10, numTurns: 1, sessionId: null, permissionDenials: [], errors: [], terminalReason: null, raw: {} })
let calls = 0
let reply = JSON.stringify({ title: 'Drafted title', body: 'Objective: make the feature. Validate with the relevant checks.', evidence: 'Invented evidence', status: 'Completed', command: 'execute nothing' })
let budget = false
let hold: ((options: HeadlessOptions) => Promise<HeadlessResult>) | null = null
const run = async (options: HeadlessOptions): Promise<HeadlessResult> => {
  calls++
  if (hold) return hold(options)
  return budget ? { ...result(''), isError: true, subtype: 'error_max_budget_usd', costUsd: 1.05 } : result(reply)
}
let service = new WorkDrafts(root, { work, options: () => ({}), run })
async function requestTask(kind: WorkDraftRequest['kind'], notes = ''): Promise<WorkDraftRequest> {
  const view = await work.read(); const task = view.tasks[0]
  return { kind, target: 'task', id: task.id, revision: task.revision, day, relatedRevision: view.daily.find((d) => d.taskId === task.id && d.day === day)?.revision, notes }
}
async function edit(title: string): Promise<void> {
  const task = (await work.read()).tasks[0]
  await work.change({ kind: 'edit', id: task.id, revision: task.revision, title, brief: task.brief, project: task.project })
}
try {
  console.log('\nWork drafts: proposals and deterministic acceptance')
  await work.change({ kind: 'enable', enabled: true })
  await work.change({ kind: 'idea', title: 'Original idea 🔥', brief: 'My ask', project: 'Stoke' })
  const before = await work.read()
  const generated = await service.generate(await requestTask('brief', 'Keep the scope small'))
  check('generation leaves board bytes unchanged', await work.read(), before)
  const draft = generated.drafts[0]
  check('model status and commands cannot change the requested action', [draft.state, draft.proposal?.evidence, draft.request.kind], ['ready', '', 'brief'])
  await service.accept(draft.id)
  check('acceptance updates the idea without approving or starting it', [(await work.read()).tasks[0].title, (await work.read()).tasks[0].status, (await work.read()).tasks[0].sessionId], ['Drafted title', 'Idea', null])

  console.log('\nWork drafts: acceptance receipts and stale records')
  service.stop()
  const journal = join(root, 'plugins', 'work-drafts.json')
  const saved = JSON.parse(await readFile(journal, 'utf8'))
  saved.drafts[0].state = 'accepting'
  await writeFile(journal, JSON.stringify(saved))
  await edit('Later local edit')
  const priorCalls = calls
  service = new WorkDrafts(root, { work, options: () => ({}), run })
  try { await service.generate(await requestTask('brief')); check('an unsettled acceptance blocks another paid draft for its record', true, false) } catch { check('an unsettled acceptance blocks another paid draft for its record', calls, priorCalls) }
  await service.accept(draft.id)
  check('restart retries a saved acceptance without overwriting later edits or rerunning Sonnet', [(await work.read()).tasks[0].title, calls, (await service.view()).drafts[0].state], ['Later local edit', priorCalls, 'accepted'])
  await service.generate(await requestTask('brief'))
  const stale = (await service.view()).drafts.at(-1)!
  await edit('Changed during review')
  try { await service.accept(stale.id); check('stale drafts cannot be accepted', true, false) } catch { check('stale drafts cannot be accepted', (await work.read()).tasks[0].title, 'Changed during review') }
  check('a settled rejected acceptance is discardable', (await service.view()).drafts.at(-1)?.state, 'failed')
  await service.reject(stale.id)
  check('discard does not rerun a model', calls, priorCalls + 1)

  console.log('\nWork drafts: summaries and completion are distinct proposals')
  await work.change({ kind: 'daily', day, title: 'Unplanned support', notes: 'Observed work' })
  let daily = (await work.read()).daily[0]
  await service.generate({ kind: 'summary', target: 'daily', id: daily.id, revision: daily.revision, day, notes: 'Resolved one support request; validation is pending' })
  const summary = (await service.view()).drafts.at(-1)!
  await service.accept(summary.id)
  daily = (await work.read()).daily[0]
  check('summaries preserve title, status and existing evidence', [daily.title, daily.status, daily.evidence], ['Unplanned support', 'To-Do', ''])
  const beforeEvidence = calls
  try { await service.generate({ kind: 'complete', target: 'daily', id: daily.id, revision: daily.revision, day, notes: '' }); check('completion requires observations before a model run', true, false) } catch { check('completion requires observations before a model run', calls, beforeEvidence) }
  let task = (await work.read()).tasks[0]
  await work.change({ kind: 'approve', id: task.id, revision: task.revision, day })
  task = (await work.read()).tasks[0]
  await work.change({ kind: 'start', id: task.id, revision: task.revision, day })
  reply = JSON.stringify({ title: 'Ignore this title', body: 'Completed the requested scope.', evidence: 'Relevant checks passed; commit abc123.' })
  await service.generate(await requestTask('complete', 'Relevant checks passed; commit abc123.'))
  const complete = (await service.view()).drafts.at(-1)!
  check('completion remains a proposal until accepted', (await work.read()).tasks[0].status, 'Working')
  const linked = (await work.read()).daily.find((d) => d.taskId === task.id)!
  await work.change({ kind: 'daily-edit', id: linked.id, revision: linked.revision, status: linked.status, notes: 'Changed during completion review', evidence: linked.evidence })
  try { await service.accept(complete.id); check('changed related days prevent stale task completion', true, false) } catch { check('changed related days prevent stale task completion', (await work.read()).tasks[0].status, 'Working') }
  await service.generate(await requestTask('complete', 'Relevant checks passed; commit abc123.'))
  await service.accept((await service.view()).drafts.at(-1)!.id)
  check('accepted completion updates its task and linked day with evidence', [(await work.read()).tasks[0].status, (await work.read()).daily.find((d) => d.taskId === task.id)?.status, (await work.read()).tasks[0].evidence], ['Completed', 'Completed', 'Relevant checks passed; commit abc123.'])

  console.log('\nWork drafts: budget, malformed replies, cancellation and restart')
  const dailyRequest = (): Promise<WorkDraftRequest> => work.read().then((w) => ({ kind: 'summary', target: 'daily', id: w.daily[0].id, revision: w.daily[0].revision, day, notes: 'Only observed work' }))
  budget = true
  await service.generate(await dailyRequest())
  check('budget exhaustion is a visible failure with reported cost', [(await service.view()).drafts.at(-1)?.state, (await service.view()).drafts.at(-1)?.costUsd], ['failed', 1.05])
  budget = false; reply = 'not JSON'
  await service.generate(await dailyRequest())
  check('malformed replies cannot appear as successful empty drafts', (await service.view()).drafts.at(-1)?.state, 'failed')
  let begun: () => void = () => {}
  const started = new Promise<void>((resolve) => { begun = resolve })
  hold = (options) => new Promise((resolve) => { options.signal!.addEventListener('abort', () => resolve(result('late cancelled result')), { once: true }); begun() })
  const pending = service.generate(await dailyRequest())
  await started
  try { await service.generate(await dailyRequest()); check('double generation is refused', true, false) } catch { check('double generation is refused', true, true) }
  await work.change({ kind: 'enable', enabled: false }); service.pause(); await pending
  check('disable cancels the active proposal and changes no board fields', [(await service.view()).drafts.at(-1)?.state, (await work.read()).enabled], ['failed', false])
  hold = null
  service.stop()
  const interrupted = JSON.parse(await readFile(journal, 'utf8'))
  interrupted.drafts.at(-1).state = 'drafting'
  await writeFile(journal, JSON.stringify(interrupted))
  service = new WorkDrafts(root, { work, options: () => ({}), run })
  const noRestartRun = calls
  check('interrupted generation never restarts or bills automatically', [(await service.view()).drafts.at(-1)?.state, calls], ['failed', noRestartRun])
  await service.reject(interrupted.drafts.at(-1).id)
  check('interrupted generations can be discarded explicitly', (await service.view()).drafts.at(-1)?.state, 'rejected')

  console.log('\nWork drafts: real owned CLI subprocess contract')
  const source = join(root, 'draft-cli.mjs')
  const capture = join(root, 'cli-capture.json')
  const ready = join(root, 'cli-ready')
  const executable = join(root, process.platform === 'win32' ? 'draft-cli.cmd' : 'draft-cli')
  await writeFile(source, [
    "import { writeFile } from 'node:fs/promises'",
    'let prompt = ""; for await (const part of process.stdin) prompt += part;',
    'const args = process.argv.slice(2);',
    `await writeFile(${JSON.stringify(capture)}, JSON.stringify({args, prompt}));`,
    "if (prompt === 'hold') process.on('SIGTERM', () => {});",
    `await writeFile(${JSON.stringify(ready)}, 'ready');`,
    "if (prompt === 'hold') { setInterval(() => {}, 1000) }",
    "else console.log(JSON.stringify({type:'result', result:JSON.stringify({title:'CLI draft',body:'Observed outcome',evidence:''}),is_error:false,total_cost_usd:0.01}));"
  ].join('\n'))
  const quote = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`
  await writeFile(executable, process.platform === 'win32' ? `@"${process.execPath}" "%~dp0draft-cli.mjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`)
  if (process.platform !== 'win32') await chmod(executable, 0o700)
  const controller = new AbortController()
  const opts = { ...workDraftOptions('quoted data & | 🔥', controller.signal, { claudePath: executable }), cwd: root }
  const real = await runHeadless(opts)
  const received = JSON.parse(await readFile(capture, 'utf8'))
  const args = buildHeadlessArgs(opts)
  check('real subprocess receives exact argv and Unicode stdin', [received.args, received.prompt, real.costUsd], [args, opts.prompt, 0.01])
  check('the run explicitly removes every built-in tool and MCP server', [args[args.indexOf('--tools') + 1], args.includes('--strict-mcp-config'), args.includes('--safe-mode'), args.includes('--no-session-persistence'), args[args.indexOf('--max-budget-usd') + 1]], ['', true, true, true, '1'])
  await rm(ready)
  const cancel = new AbortController()
  let settled = false
  const owned = runHeadless({ ...opts, prompt: 'hold', signal: cancel.signal }).then(() => { settled = true; return 'success' }, () => { settled = true; return 'cancelled' })
  let seen = false
  for (let n = 0; n < 200; n++) { try { await readFile(ready); seen = true; break } catch { await new Promise((resolve) => setTimeout(resolve, 10)) } }
  check('the held subprocess actually started', seen, true)
  cancel.abort()
  if (process.platform !== 'win32') { await new Promise((resolve) => setTimeout(resolve, 100)); check('abort holds ownership while the child ignores SIGTERM', settled, false) }
  check('the owned child is eventually closed and cancelled', await owned, 'cancelled')
  const early = new AbortController(); early.abort(); await rm(ready)
  try { await runHeadless({ ...opts, signal: early.signal }); check('an already cancelled request never spawns', true, false) } catch { try { await readFile(ready); check('an already cancelled request never spawns', true, false) } catch { check('an already cancelled request never spawns', true, true) } }
  try { await runHeadless({ ...opts, prompt: 'hold', signal: undefined, timeoutMs: 100 }); check('a timed-out owned child closes before the failure reply', true, false) } catch (err) { check('a timed-out owned child closes before the failure reply', (err as Error).message.includes('timed out after 100ms'), true) }
} finally { service.stop(); work.stop(); await rm(root, { recursive: true, force: true }) }
console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exitCode = failures ? 1 : 0
