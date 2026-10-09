import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkPlugin } from '../src/main/plugins/work.ts'
import { WorkCredentials } from '../src/main/plugins/workCredentials.ts'
import { NotionClient, NOTION_VERSION, notionText, validateNotionMapping } from '../src/main/plugins/notion.ts'
import { NotionWork } from '../src/main/plugins/notionWork.ts'
import { mergeNotionFields } from '../src/shared/workNotion.ts'
import type { NotionFields, WorkNotionPublishRequest } from '../src/shared/workNotion.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const okay = JSON.stringify(actual) === JSON.stringify(expected)
  if (!okay) failures++
  console.log(`  ${okay ? 'PASS' : 'FAIL'} ${name}${okay ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
const root = await mkdtemp(join(tmpdir(), 'stoke-notion-'))
const taskSource = '11111111-1111-4111-8111-111111111111'
const dailySource = '22222222-2222-4222-8222-222222222222'
const token = ['notion', 'synthetic', randomBytes(8).toString('hex')].join('-')
const key = randomBytes(32)
const backend = {
  isEncryptionAvailable: () => true,
  selectedBackend: () => null,
  encrypt: (plain: string): Buffer => {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), body])
  },
  decrypt: (sealed: Buffer): string => {
    const cipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12)); cipher.setAuthTag(sealed.subarray(12, 28))
    return Buffer.concat([cipher.update(sealed.subarray(28)), cipher.final()]).toString('utf8')
  }
}
const taskMap = { source: taskSource, title: 'title', body: 'brief', status: 'status', identity: 'stoke-id', evidence: 'evidence', project: 'project', states: { Idea: 'Idea', Approved: 'Approved', Working: 'Working', Completed: 'Completed' } }
const dailyMap = { source: dailySource, title: 'title', body: 'notes', status: 'status', identity: 'stoke-id', evidence: 'evidence', day: 'day', task: 'task', states: { 'To-Do': 'To-Do', 'Working on': 'Working on', Completed: 'Completed' } }
function schema(source: string): Record<string, unknown> {
  const common = { title: { id: 'title', type: 'title', title: {} }, status: { id: 'status', type: 'status', status: { options: (source === taskSource ? Object.values(taskMap.states) : Object.values(dailyMap.states)).map((name) => ({ name })) } } }
  const properties: Record<string, unknown> = { ...common }
  for (const id of ['stoke-id', 'evidence', source === taskSource ? 'brief' : 'notes', ...(source === taskSource ? ['project'] : [])]) properties[id] = { id, type: 'rich_text', rich_text: {} }
  if (source === dailySource) {
    properties.day = { id: 'day', type: 'date', date: {} }
    properties.task = { id: 'task', type: 'relation', relation: { data_source_id: taskSource, database_id: taskSource, type: 'single_property', single_property: {} } }
  }
  return { object: 'data_source', id: source, title: [{ plain_text: source === taskSource ? 'Tasks' : 'Daily work' }], properties }
}
const pages = new Map<string, any>()
let sequence = 0
let versionsOkay = true
let authOkay = true
let writes = 0
let taskCreates = 0
let dailyCreates = 0
let patches = 0
let hiddenLookups = 0
let unknownCreate = false
let refuseDaily = false
let echoError = false
let redirect = false
let slow = false
let blockedPatch: (() => void) | null = null
let sawPatch: (() => void) | null = null
let patchSeen: Promise<void> | null = null
let releasePatch: (() => void) | null = null
const value = (page: any, property: string): string => (page.properties[property]?.rich_text ?? page.properties[property]?.title ?? []).map((r: any) => r.plain_text ?? r.text?.content ?? '').join('')
const rich = (text: string): any => ({ type: 'rich_text', rich_text: notionText(text) })
const server = createServer(async (req, res) => {
  versionsOkay &&= req.headers['notion-version'] === NOTION_VERSION
  authOkay &&= req.headers.authorization === `Bearer ${token}`
  const reply = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (redirect) { res.writeHead(302, { location: 'http://127.0.0.1:1/credential-trap' }); res.end(); return }
  if (slow) { setTimeout(() => reply(200, schema(taskSource)), 200); return }
  if (echoError) { reply(401, { message: req.headers.authorization }); return }
  let text = ''; for await (const part of req) text += part
  const body = text ? JSON.parse(text) : null
  const route = req.url ?? ''
  if (req.method === 'GET' && route.startsWith('/v1/data_sources/')) { reply(200, schema(route.split('/')[3])); return }
  if (route.endsWith('/query')) {
    const source = route.split('/')[3]
    const found = [...pages.values()].filter((p) => p.parent.data_source_id === source && value(p, 'stoke-id') === body.filter.rich_text.equals)
    const results = found.length && hiddenLookups > 0 ? (hiddenLookups--, []) : found
    reply(200, { object: 'list', has_more: false, results }); return
  }
  if (req.method === 'POST' && route === '/v1/pages') {
    const source = body.parent.data_source_id
    if (source === dailySource && refuseDaily) { refuseDaily = false; reply(400, { message: req.headers.authorization }); return }
    const id = `33333333-3333-4333-8333-${String(++sequence).padStart(12, '0')}`
    const properties = Object.fromEntries(Object.entries(body.properties).map(([property, v]) => [property, { id: property, type: Object.keys(v as object)[0], ...v as object }]))
    properties.unrelated = { id: 'unrelated', type: 'rich_text', rich_text: notionText('A bystander property') }
    const page = { object: 'page', id, parent: { type: 'data_source_id', data_source_id: source }, url: `https://www.notion.so/${id.replace(/-/g, '')}`, last_edited_time: new Date(1000 + sequence).toISOString(), properties }
    pages.set(id, page); writes++; if (source === taskSource) taskCreates++; else dailyCreates++
    if (unknownCreate) { unknownCreate = false; req.socket.destroy(); return }
    reply(200, page); return
  }
  const id = route.split('/')[3]
  const page = pages.get(id)
  if (!page) { reply(404, { message: 'missing' }); return }
  if (req.method === 'PATCH') {
    for (const [property, v] of Object.entries(body.properties)) page.properties[property] = { id: property, type: Object.keys(v as object)[0], ...v as object }
    page.last_edited_time = new Date(2000 + ++sequence).toISOString(); writes++; patches++
    if (blockedPatch) { const wait = new Promise<void>((resolve) => { releasePatch = resolve }); sawPatch?.(); await wait; blockedPatch = null }
  }
  reply(200, page)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const localFetch: typeof fetch = (url, init) => {
  const requested = new URL(String(url))
  if (requested.origin !== 'https://api.notion.com') throw new Error('Unexpected external request')
  return fetch(`${origin}${requested.pathname}`, init)
}
let work = new WorkPlugin(root)
const credentials = new WorkCredentials(root, backend, 'darwin')
let connector = new NotionWork(root, { work, credentials, fetch: localFetch })
const day = '2026-10-09'
async function publishTask(id: string): Promise<void> {
  const w = await work.read(); const n = await connector.view(); const row = w.tasks.find((r) => r.id === id)!
  const daily = w.daily.find((r) => r.taskId === id && r.day === day)
  await connector.publish({ kind: 'task', id, revision: row.revision, day, relatedRevision: daily?.revision, connectionId: n.config!.connectionId })
}
async function edit(id: string, title: string, brief: string): Promise<void> {
  const row = (await work.read()).tasks.find((r) => r.id === id)!
  await work.change({ kind: 'edit', id, revision: row.revision, title, brief, project: row.project })
}
try {
  console.log('\nNotion: protected token and schema mapping')
  await work.change({ kind: 'enable', enabled: true })
  const sources = await connector.inspect(taskSource, dailySource, token)
  check('inspection returns full closed status vocabulary', sources.task.properties.find((p) => p.id === 'status')?.options, Object.values(taskMap.states))
  check('relation schema points to the selected task source', sources.daily.properties.find((p) => p.id === 'task')?.relatedSource, taskSource)
  check('inspection stores no token', await credentials.present(), false)
  await connector.configure({ task: taskMap, daily: dailyMap }, token)
  const n = await connector.view()
  check('connection returns only credential presence', [n.tokenPresent, JSON.stringify(n).includes(token)], [true, false])
  check('the token never appears in the journal or ciphertext file', [(await readFile(join(root, 'plugins', 'work-notion.json'), 'utf8')).includes(token), (await readFile(credentials.file, 'utf8')).includes(token)], [false, false])
  check('the sealed token opens under the injected key store', await credentials.read() === token, true)
  const wrong = { ...dailyMap, task: 'notes' }
  check('a text field cannot stand in for the relation', (() => { try { validateNotionMapping({ task: taskMap, daily: wrong }, sources.task, sources.daily); return false } catch { return true } })(), true)
  const unknownStatus = { ...taskMap, states: { ...taskMap.states, Completed: 'Invented' } }
  check('invented completion states are refused', (() => { try { validateNotionMapping({ task: unknownStatus, daily: dailyMap }, sources.task, sources.daily); return false } catch { return true } })(), true)
  const unicode = 'x'.repeat(1999) + '🔥' + 'y'.repeat(2001)
  const chunks = notionText(unicode)
  check('long Unicode text survives property chunking', chunks.map((c) => c.text.content).join(''), unicode)
  check('chunks respect API limits and preserve surrogate pairs', chunks.every((c) => c.text.content.length <= 2000 && !/[\uD800-\uDBFF]$/.test(c.text.content)), true)

  console.log('\nNotion: known writes, external authority and field conflicts')
  await work.change({ kind: 'idea', title: 'Stoke 🔥', brief: unicode, project: 'Stoke' })
  const taskId = (await work.read()).tasks[0].id
  await publishTask(taskId)
  let state = await connector.view()
  const pageId = state.links.find((l) => l.recordId === taskId)!.id
  check('one accepted publish creates one row with a stable identity', [taskCreates, value(pages.get(pageId), 'stoke-id') === taskId, state.operations[0].state], [1, true, 'completed'])
  check('unrelated properties are retained', value(pages.get(pageId), 'unrelated'), 'A bystander property')
  pages.get(pageId).properties.title = { id: 'title', type: 'title', title: notionText('Renamed in Notion') }
  await edit(taskId, 'Stoke 🔥', 'A new local brief')
  await publishTask(taskId)
  check('independent local and external edits merge', [(await work.read()).tasks[0].title, value(pages.get(pageId), 'brief')], ['Renamed in Notion', 'A new local brief'])
  await edit(taskId, 'Local title', 'A new local brief')
  pages.get(pageId).properties.title = { id: 'title', type: 'title', title: notionText('External title') }
  const beforeConflict = patches
  await publishTask(taskId)
  state = await connector.view()
  const conflict = state.operations.at(-1)!
  check('same-field edits return to review without a PATCH', [conflict.state, patches], ['conflict', beforeConflict])
  await connector.resolve(conflict.id, 'notion')
  check('accepting Notion imports its reviewed title', (await work.read()).tasks[0].title, 'External title')
  check('conflict resolution keeps one destination row', taskCreates, 1)

  await edit(taskId, 'Reviewed local title', 'A new local brief')
  pages.get(pageId).properties.title = { id: 'title', type: 'title', title: notionText('First external conflict') }
  await publishTask(taskId)
  const refreshedConflict = (await connector.view()).operations.at(-1)!
  pages.get(pageId).properties.title = { id: 'title', type: 'title', title: notionText('Changed after review') }
  const beforeResolution = patches
  await connector.resolve(refreshedConflict.id, 'stoke')
  check('a changed conflict requires another review before writing', [(await connector.view()).operations.at(-1)?.state, patches], ['conflict', beforeResolution])
  await connector.resolve(refreshedConflict.id, 'stoke')
  check('the reviewed Stoke choice updates the existing row', [value(pages.get(pageId), 'title'), taskCreates, (await connector.view()).operations.at(-1)?.state], ['Reviewed local title', 1, 'completed'])
  await edit(taskId, 'External title', 'A new local brief')
  await publishTask(taskId)

  console.log('\nNotion: a later local edit survives an in-flight write')
  await edit(taskId, 'External title', 'Brief offered for publish')
  pages.get(pageId).properties.title = { id: 'title', type: 'title', title: notionText('New external title') }
  patchSeen = new Promise<void>((resolve) => { sawPatch = resolve }); blockedPatch = () => {}
  const pending = publishTask(taskId)
  await patchSeen
  await edit(taskId, 'External title', 'Newer local draft')
  releasePatch!(); await pending
  check('the late reply cannot overwrite a newer local draft', (await work.read()).tasks[0].brief, 'Newer local draft')
  await publishTask(taskId)
  check('the next publish does not mistake an old unchanged title for a local revert', [(await work.read()).tasks[0].title, value(pages.get(pageId), 'brief'), (await connector.view()).operations.at(-1)?.state], ['New external title', 'Newer local draft', 'completed'])

  const currentReview = (await work.read()).tasks[0]
  const staleReview: WorkNotionPublishRequest = { kind: 'task', id: taskId, revision: currentReview.revision, day, connectionId: (await connector.view()).config!.connectionId }
  await edit(taskId, currentReview.title, 'Changed after the publish preview')
  const beforeStale = writes
  try { await connector.publish(staleReview); check('stale previews cannot publish', true, false) } catch { check('stale previews cannot publish', writes, beforeStale) }
  patchSeen = new Promise<void>((resolve) => { sawPatch = resolve }); blockedPatch = () => {}
  const interrupted = publishTask(taskId)
  await patchSeen
  try { await publishTask(taskId); check('an in-flight claim refuses a second publish', true, false) } catch { check('an in-flight claim refuses a second publish', true, true) }
  await work.change({ kind: 'enable', enabled: false }); connector.pause()
  await interrupted
  const paused = (await connector.view()).operations.at(-1)!
  check('disabling in flight leaves a recoverable uncertain write', paused.state, 'unknown')
  releasePatch!()
  await work.change({ kind: 'enable', enabled: true })
  await connector.retry(paused.id)
  check('re-enabling recovers the saved write without another PATCH', [(await connector.view()).operations.at(-1)?.state, value(pages.get(pageId), 'brief')], ['completed', 'Changed after the publish preview'])

  pages.get(pageId).properties.status = { id: 'status', type: 'status', status: { name: 'Completed' } }
  pages.get(pageId).properties.evidence = { id: 'evidence', ...rich('') }
  const beforeEvidence = patches
  await publishTask(taskId)
  const invalidCompletion = (await connector.view()).operations.at(-1)!
  check('external completion without evidence returns a visible conflict', [invalidCompletion.state, invalidCompletion.steps[0].page?.id, patches], ['conflict', pageId, beforeEvidence])
  try { await connector.resolve(invalidCompletion.id, 'notion'); check('invalid completion cannot be adopted', true, false) } catch { check('invalid completion cannot be adopted', (await work.read()).tasks[0].status, 'Idea') }
  pages.get(pageId).properties.status = { id: 'status', type: 'status', status: { name: 'Idea' } }
  await connector.resolve(invalidCompletion.id, 'notion')
  await connector.resolve(invalidCompletion.id, 'notion')
  check('corrected external completion can be reviewed and finished', (await connector.view()).operations.at(-1)?.state, 'completed')

  console.log('\nNotion: ambiguous create results survive restart without duplicates')
  await work.change({ kind: 'daily', day, title: 'Unexpected support work', notes: 'A local draft' })
  const dailyId = (await work.read()).daily[0].id
  const request: WorkNotionPublishRequest = { kind: 'daily', id: dailyId, revision: 1, day, connectionId: (await connector.view()).config!.connectionId }
  unknownCreate = true; hiddenLookups = 1
  await connector.publish(request)
  const unknown = (await connector.view()).operations.at(-1)!
  check('a dropped reply is explicitly uncertain', unknown.state, 'unknown')
  const created = dailyCreates
  connector.stop(); work.stop()
  work = new WorkPlugin(root); connector = new NotionWork(root, { work, credentials, fetch: localFetch })
  await connector.retry(unknown.id)
  check('an empty uncertain lookup never repeats a create', [dailyCreates, (await connector.view()).operations.at(-1)?.state], [created, 'unknown'])
  await connector.retry(unknown.id)
  check('a later matching row is adopted without another create', [dailyCreates, (await connector.view()).operations.at(-1)?.state], [created, 'completed'])

  console.log('\nNotion: a refused second write finishes the same journal operation')
  const row = (await work.read()).tasks[0]
  await work.change({ kind: 'approve', id: row.id, revision: row.revision, day })
  let current = (await work.read()).tasks[0]
  await work.change({ kind: 'start', id: current.id, revision: current.revision, day })
  current = (await work.read()).tasks[0]
  await work.change({ kind: 'complete', id: current.id, revision: current.revision, day, evidence: 'Checks passed; commit abc123' })
  refuseDaily = true
  await publishTask(taskId)
  const partial = (await connector.view()).operations.at(-1)!
  check('one confirmed table and one refused table are shown as partial', [partial.state, partial.steps.map((s) => s.state)], ['partial', ['confirmed', 'pending']])
  const beforeRetry = taskCreates
  await connector.retry(partial.id)
  check('retry finishes the same operation without repeating the task create', [(await connector.view()).operations.at(-1)?.id, (await connector.view()).operations.at(-1)?.state, taskCreates], [partial.id, 'completed', beforeRetry])
  const linkedDay = (await work.read()).daily.find((r) => r.taskId === taskId)!
  const dayPage = pages.get((await connector.view()).links.find((l) => l.recordId === linkedDay.id)!.id)
  check('the daily relation points to the confirmed task page', dayPage.properties.task.relation, [{ id: pageId }])
  check('completion evidence is published in both tables', [value(pages.get(pageId), 'evidence'), value(dayPage, 'evidence')], ['Checks passed; commit abc123', 'Checks passed; commit abc123'])

  console.log('\nNotion: transport, disable and credential boundaries')
  check('all requests carry the pinned version and the expected token', [versionsOkay, authOkay], [true, true])
  echoError = true
  const client = new NotionClient(token, { fetch: localFetch })
  try { await client.source(taskSource); check('401 is refused', true, false) } catch (err) { check('credential echoes never reach an error message', (err as Error).message.includes(token), false) }
  echoError = false; redirect = true
  try { await client.source(taskSource); check('redirects are refused', true, false) } catch { check('redirects are refused', true, true) }
  redirect = false; slow = true
  try { await new NotionClient(token, { fetch: localFetch, timeoutMs: 30 }).source(taskSource); check('slow requests expire', true, false) } catch { check('slow requests expire', true, true) }
  slow = false
  await work.change({ kind: 'enable', enabled: false }); connector.pause()
  const beforeDisabled = writes
  try { await connector.publish(request); check('disabled Work refuses writes', true, false) } catch { check('disabled Work refuses writes', writes, beforeDisabled) }
  const plainBackend = { ...backend, selectedBackend: () => 'basic_text' }
  const unsafe = new WorkCredentials(join(root, 'unsafe'), plainBackend, 'linux')
  try { await unsafe.write(token); check('basic_text cannot store Notion tokens', true, false) } catch { check('basic_text cannot store Notion tokens', await unsafe.present(), false) }
  await connector.disconnect()
  check('disconnect clears the credential but retains journal and local boards', [(await connector.view()).tokenPresent, (await connector.view()).operations.length > 0, (await work.read()).tasks.length], [false, true, 1])
  const bad = '{do not replace this uncertain journal'
  connector.stop()
  await writeFile(join(root, 'plugins', 'work-notion.json'), bad)
  const broken = new NotionWork(root, { work, credentials, fetch: localFetch })
  try { await broken.view(); check('corrupt journals refuse new operations', true, false) } catch { check('corrupt journals are not overwritten', await readFile(join(root, 'plugins', 'work-notion.json'), 'utf8'), bad) }
  broken.stop()

  const fields: NotionFields = { title: 'old', body: 'old', status: 'Idea', identity: 'record', evidence: '', project: '' }
  const merged = mergeNotionFields({ ...fields, title: 'remote' }, { ...fields, body: 'new draft' }, { ...fields, title: 'remote' }, fields)
  check('separate local and remote baselines preserve pending edits', [merged.fields.title, merged.fields.body, merged.conflicts], ['remote', 'new draft', []])
} finally {
  releasePatch?.(); connector.stop(); work.stop(); server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exitCode = failures ? 1 : 0
