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

/** Records which destinations were actually written, so a duplicate is visible. */
function recorder(fail?: string): { calls: string[]; run: never } {
  const calls: string[] = []
  const run = async (o: { allowedTools?: string[] }): Promise<unknown> => {
    const tool = o.allowedTools?.[0] ?? '?'
    const target = /notion/i.test(tool) ? 'notion' : 'clickup'
    calls.push(target)
    if (target === fail) throw new Error('simulated failure')
    return {
      text: `https://example.com/${target}/123`,
      isError: false,
      costUsd: 0.01,
      subtype: 'success'
    }
  }
  return { calls, run: run as never }
}

console.log('a clean accept writes both, once each')
{
  const r = recorder()
  const out = await applyProposal(base, { run: r.run })
  check('both written, in order', r.calls.join(',') === 'clickup,notion', r.calls.join(','))
  check('reported ok', out.ok)
}

console.log('\na half-success keeps the url that worked')
const half = recorder('notion')
const halfOut = await applyProposal(base, { run: half.run })
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
  const out = await applyProposal(retried, { run: r.run })
  check('clickup was NOT written again', !r.calls.includes('clickup'), `wrote: ${r.calls.join(',') || 'nothing'}`)
  check('only the missing destination ran', r.calls.join(',') === 'notion', r.calls.join(','))
  check('the existing url is carried through', out.urls.clickup === halfOut.urls.clickup)
  check('and the retry completes the item', out.ok)
}

console.log('\na destination not on the proposal is never written')
{
  const r = recorder()
  await applyProposal({ ...base, targets: ['notion'] }, { run: r.run })
  check('clickup skipped', r.calls.join(',') === 'notion', r.calls.join(','))
}

console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)
process.exitCode = failed === 0 ? 0 : 1
