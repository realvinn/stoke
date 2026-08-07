/**
 * The accept path writes to real Notion and ClickUp workspaces, so its most
 * dangerous behaviour — retrying after a half-success — cannot be exercised for
 * real without leaving duplicate records in the user's own tools.
 *
 * `applyProposal` therefore takes an injectable runner, and this exercises the
 * ordering guarantees against it: writes happen once each, a failure on the
 * second destination never discards the first, and a retry skips whatever
 * already succeeded. Without that last one, "Try again" on a half-written item
 * creates a second ClickUp task and nothing anywhere reports it.
 *
 *   node scripts/verify-worklog-retry.mts
 */
import { applyProposal } from '../src/main/worklog/runner.ts'
import type { WorklogProposal } from '../src/shared/types.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const base: WorklogProposal = {
  id: 'p1',
  sessionId: 's1',
  cwd: 'G:/Code/gitea-company/refinity',
  group: 'gitea-company',
  title: 'Fix the thing',
  body: 'Did the thing.',
  targets: ['clickup', 'notion'],
  status: 'pending',
  createdAt: 0
}

/*
 * The ordering/retry tests below are about what happens when TWO destinations
 * are in play, which since this task means both have to be explicitly
 * switched on: the safe default when `boards` is absent is Notion only (an
 * unconfigured install must never write to ClickUp by accident), so a
 * two-destination proposal run without this would silently narrow itself to
 * one write and the tests would stop testing what their names say.
 */
const bothBoards = { targets: ['notion', 'clickup'], notionDataSource: 'x', clickupListId: '1' }

/** Records which destinations were actually written, so a duplicate is visible. */
function recorder(fail?: string): { calls: string[]; run: never } {
  const calls: string[] = []
  const run = async (o: { allowedTools?: string[] }): Promise<unknown> => {
    const tool = o.allowedTools?.[0] ?? '?'
    const target = /notion/i.test(tool) ? 'notion' : 'clickup'
    calls.push(target)
    if (target === fail) throw new Error('simulated failure')
    // Realistic hosts: parseWrittenUrl only accepts a link the destination owns,
    // so a placeholder domain is correctly treated as "no link returned".
    const text =
      target === 'clickup'
        ? 'Created https://app.clickup.com/t/abc123'
        : 'Created https://www.notion.so/Fix-the-thing-abc123'
    return { text, isError: false, costUsd: 0.01, subtype: 'success' }
  }
  return { calls, run: run as never }
}

console.log('a clean accept writes both, once each')
{
  const r = recorder()
  const out = await applyProposal(base, { run: r.run, boards: bothBoards })
  check('both written, in order', r.calls.join(',') === 'clickup,notion', r.calls.join(','))
  check('reported ok', out.ok)
}

console.log('\na half-success keeps the url that worked')
const half = recorder('notion')
const halfOut = await applyProposal(base, { run: half.run, boards: bothBoards })
check('the clickup url survives', !!halfOut.urls.clickup)
check('the notion failure is recorded', !!halfOut.errors.notion)
check('the accept is not reported ok', !halfOut.ok)

console.log('\nretrying that half-success must not write clickup twice')
{
  const retried: WorklogProposal = {
    ...base,
    status: 'failed',
    urls: { clickup: halfOut.urls.clickup as string }
  }
  const r = recorder()
  const out = await applyProposal(retried, { run: r.run, boards: bothBoards })
  check('clickup was NOT written again', !r.calls.includes('clickup'), `wrote: ${r.calls.join(',') || 'nothing'}`)
  check('only the missing destination ran', r.calls.join(',') === 'notion', r.calls.join(','))
  check('the existing url is carried through', out.urls.clickup === halfOut.urls.clickup)
  check('and the retry completes the item', out.ok)
}

console.log('\na write that returns no usable link still counts as written')
{
  // The run succeeds but the reply carries no link the destination owns. This
  // used to leave urls[target] unset, so a retry wrote the record a second time.
  const calls: string[] = []
  const run = (async (o: { allowedTools?: string[] }) => {
    calls.push(/notion/i.test(o.allowedTools?.[0] ?? '') ? 'notion' : 'clickup')
    return { text: 'Created it. See https://example.com/docs for context.', isError: false, costUsd: 0, subtype: 'success' }
  }) as never
  const out = await applyProposal(base, { run, boards: bothBoards })
  check('both destinations attempted once', calls.join(',') === 'clickup,notion', calls.join(','))
  check('an unrelated link is not accepted as the record', !out.urls.clickup, JSON.stringify(out.urls))
  check('but the destination is marked reached', out.urls.clickup === '', JSON.stringify(out.urls))

  const retryCalls: string[] = []
  const retryRun = (async (o: { allowedTools?: string[] }) => {
    retryCalls.push(/notion/i.test(o.allowedTools?.[0] ?? '') ? 'notion' : 'clickup')
    return { text: 'ok', isError: false, costUsd: 0, subtype: 'success' }
  }) as never
  await applyProposal({ ...base, status: 'failed', urls: out.urls }, { run: retryRun, boards: bothBoards })
  check('so a retry writes nothing again', retryCalls.length === 0, `wrote: ${retryCalls.join(',') || 'nothing'}`)
}

console.log('\na destination not on the proposal is never written')
{
  const r = recorder()
  await applyProposal({ ...base, targets: ['notion'] }, { run: r.run, boards: bothBoards })
  check('clickup skipped', r.calls.join(',') === 'notion', r.calls.join(','))
}

/*
 * `boards` omitted entirely, not just "notion switched on" - this is the
 * fallback an unconfigured install actually hits, and it must land on Notion
 * only. `base.targets` includes clickup, so this only passes if the default
 * itself excludes clickup, not because the proposal never asked for it.
 */
console.log('\nan unconfigured install writes Notion only')
{
  const r = recorder()
  await applyProposal(base, { run: r.run }) // deliberately no boards
  check('the default is Notion only', r.calls.join(',') === 'notion', r.calls.join(','))
}

console.log('\na board switched off in settings is never written')
{
  const r = recorder()
  const out = await applyProposal(base, {
    run: r.run,
    boards: { targets: ['notion'], notionDataSource: 'collection://x', clickupListId: '1' }
  })
  check('only the configured board ran', r.calls.join(',') === 'notion', r.calls.join(','))
  check('and it is reported as written', !!out.urls.notion)
}

console.log('\na proposal addressed only to a switched-off board fails out loud')
{
  const r = recorder()
  const out = await applyProposal(
    { ...base, targets: ['clickup'] },
    {
      run: r.run,
      boards: { targets: ['notion'], notionDataSource: 'collection://x', clickupListId: '1' }
    }
  )
  check('nothing was written', r.calls.length === 0, r.calls.join(','))
  check('the accept is not reported ok', !out.ok)
  check('and it says why', !!out.errors.clickup, JSON.stringify(out.errors))
}

console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)
process.exitCode = failed === 0 ? 0 : 1
