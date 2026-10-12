/** Owned homes and independent OS-key-store fixtures; never reads vendor logins or calls a provider. */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountSync } from '../src/main/hub/accountSync.ts'
import { GrokBotPlugin } from '../src/main/plugins/grokBot.ts'
import { GrokBotSessionReader } from '../src/main/plugins/grokBotSession.ts'
import { accountsRoot, defaultTrees, makeAccountHome } from '../src/main/accounts.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { codexAuthProblem, syncedAccountProblem, type SyncedAccount } from '../src/shared/hub/accountSync.ts'
import { parseItemPath, itemPath } from '../src/shared/hub/items.ts'
import { inScope } from '../src/shared/hub/client.ts'
import { stableJson } from '../src/shared/hub/codec.ts'
import { agentLaunchPlan } from '../src/shared/agents.ts'
import { planAccountIdentity } from '../src/main/accountIdentity.ts'
import type { SecretBackend } from '../src/main/secrets.ts'
import type { Settings } from '../src/shared/types.ts'
let checks = 0
const check = (label: string, fn: () => void) => { fn(); checks++; console.log('  PASS '+label) }
const root = await mkdtemp(join(tmpdir(), 'stoke-account-sync-'))
const cache = (email: string, rev: number) => stableJson({auth_mode:'chatgpt',tokens:{id_token:`e30.${Buffer.from(JSON.stringify({email,sub:email})).toString('base64url')}.owned`,access_token:['owned','access',email,rev].join('-'),refresh_token:['owned','refresh',email,rev].join('-'),account_id:'fixture-'+email},last_refresh:new Date(Date.UTC(2026,9,12,1,rev)).toISOString()})
function backend(selected: string | null = null): SecretBackend {
  const key = randomBytes(32)
  return {isEncryptionAvailable:()=>true,selectedBackend:()=>selected,encrypt: value=>{const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()])},decrypt: value=>{const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString()}}
}
async function device(label: string, platform: string, linuxStore = 'gnome_libsecret') {
  const home=join(root,label), ud=join(home,'stoke'), keyStore=backend(platform === 'linux' ? linuxStore : null), trees=defaultTrees({},home)
  await mkdir(ud,{recursive:true});await mkdir(trees.codex,{recursive:true});await mkdir(trees.claude,{recursive:true})
  let settings=hydrateSettings({}), enabled=true
  const busy=new Set<string>(), publicViews: string[]=[]
  const bots=new GrokBotPlugin({root:join(ud,'plugins'),executable:process.execPath,runner:'',platform,environment:{},backend:keyStore,reader:new GrokBotSessionReader({home,platform,environment:{}}),enabled:async()=>enabled,changed:v=>publicViews.push(JSON.stringify(v))})
  const adapter=new AccountSync({userData:ud,root:accountsRoot(home),trees,platform,label,backend:keyStore,getSettings:()=>settings,commit:patch=>settings=hydrateSettings({...settings,...patch}),active:(_cli,id)=>busy.has(id),grok:async()=>bots,changed:()=>{}})
  return {home,ud,trees,busy,bots,adapter,publicViews,get:()=>settings,set:(patch:Partial<Settings>)=>settings=hydrateSettings({...settings,...patch}),disable:()=>{enabled=false;bots.stop()}}
}
try {
  const windows=await device('Windows PC','win32'), mac=await device('Mac','darwin')
  const original=cache('mac-default@example.test',1)
  await writeFile(join(mac.trees.codex,'auth.json'),original)
  await writeFile(join(mac.trees.codex,'config.toml'),'cli_auth_credentials_store = "keyring"\n')
  const wh=await makeAccountHome({root:accountsRoot(windows.home),id:'codex-profile-1',cli:'codex',trees:windows.trees,platform:process.platform})
  await writeFile(join(wh.home,'auth.json'),cache('profile-1@example.test',1))
  windows.set({accounts:{'codex-profile-1':{id:'codex-profile-1',cli:'codex',label:'Profile 1',kind:'login',home:wh.home,apiKey:''}}})
  await assert.rejects(windows.adapter.snapshot(()=>false),/no longer enabled/)
  check('a disabled sync request cannot gather credentials',()=>assert.equal(windows.get().accounts['codex-profile-1'].label,'Profile 1'))
  const snap=await windows.adapter.snapshot(()=>true), [id,payload]=[...snap][0]
  check('portable records contain no source home or CLI configuration',()=>{assert.equal(stableJson(payload).includes(windows.home),false);assert.equal('home' in payload,false)})
  check('account item grammar and scope are separate from API key sync',()=>{const p=parseItemPath('t5/account/'+id);assert.ok(p);assert.equal(itemPath(p),'t5/account/'+id);assert.equal(inScope('t5/account/'+id,{settings:true,hosts:true,keys:true}),false);assert.equal(inScope('t5/account/'+id,{settings:false,hosts:false,keys:false,accounts:true}),true)})
  check('paths, wrong-agent logins and unsafe Grok gateways are rejected',()=>{assert.ok(syncedAccountProblem({...payload,home:'C:\\credentials'}));assert.ok(syncedAccountProblem({...payload,cli:'claude'}));assert.ok(syncedAccountProblem({v:1,kind:'grok-bot',label:'Bot',credential:{gatewayUrl:'https://credentials.example.test',token:'owned-token',headers:{}}}))})
  check('a malformed or incomplete native cache cannot be published',()=>{assert.ok(codexAuthProblem('{'));assert.ok(codexAuthProblem('{"tokens":{}}'))})
  const linux=await device('Linux','linux'), plainLinux=await device('Plain Linux','linux','basic_text')
  await linux.adapter.apply(id,payload,()=>true)
  check('Linux Secret Service can receive and locally protect portable account credentials',()=>assert.equal(Object.values(linux.get().accounts)[0]?.credentialStore,'file'))
  await assert.rejects(plainLinux.adapter.snapshot(()=>true),/OS key store/)
  await assert.rejects(plainLinux.adapter.apply(id,payload,()=>true),/OS key store/)
  check('Linux basic_text cannot upload or import account credentials',()=>assert.equal(Object.keys(plainLinux.get().accounts).length,0))
  const collision='codex-vault-'+id.slice(3,27)
  const collisionHome=await makeAccountHome({root:accountsRoot(mac.home),id:collision,cli:'codex',trees:mac.trees,platform:process.platform})
  await writeFile(join(collisionHome.home,'auth.json'),cache('bystander@example.test',1))
  mac.set({accounts:{[collision]:{id:collision,cli:'codex',kind:'login',label:'Profile 1',home:collisionHome.home,apiKey:''}}})
  await mac.adapter.apply(id,payload,()=>true)
  const incoming=Object.values(mac.get().accounts).find(a=>a.id!==collision)!
  check('an existing local ID and same nickname do not get overwritten',()=>{assert.ok(incoming);assert.equal(mac.get().accounts[collision].home,collisionHome.home);assert.equal(incoming.id,collision+'-2')})
  const localRoot=await realpath(accountsRoot(mac.home))
  check('Windows credentials are installed into a distinct Mac home',()=>{assert.ok(incoming.home.startsWith(localRoot));assert.notEqual(incoming.home,wh.home)})
  check('the Mac Default login and keyring configuration are preserved',()=>assert.notEqual(incoming.home,mac.trees.codex))
  assert.equal(await readFile(join(mac.trees.codex,'auth.json'),'utf8'),original)
  const launch=agentLaunchPlan({id:'codex',endpoint:{mode:'default',baseUrl:'',apiKey:'',model:''},openrouterKey:'',mcp:[],account:incoming})
  check('a synced native profile reads the imported file at launch',()=>{assert.equal(launch.ok,true);if(launch.ok)assert.ok(launch.plan.args.includes('cli_auth_credentials_store="file"'))})
  const identity=planAccountIdentity({cli:'codex',accountId:incoming.id},mac.get(),{},mac.home)
  check('identity probes use the same imported credential store',()=>assert.deepEqual(identity.nativeArgs,['-c','cli_auth_credentials_store="file"']))
  const subscription=agentLaunchPlan({id:'codex',endpoint:{mode:'custom',baseUrl:'https://different-api.example.test/v1',apiKey:'owned-global-key',model:'api-model'},openrouterKey:'',mcp:[],account:incoming})
  check('a selected subscription login cannot inherit the global API route',()=>{assert.equal(subscription.ok,true);if(subscription.ok){assert.ok(!subscription.plan.args.some(a=>a.includes('different-api')||a.includes('api-model')||a.startsWith('model_provider=')));assert.ok(!Object.values(subscription.plan.env).includes('owned-global-key'))}})
  check('a received profile maps back to the same vault ID',()=>assert.equal(incoming.credentialStore,'file'))
  assert.ok((await mac.adapter.snapshot(()=>true)).has(id))
  mac.busy.add(incoming.id)
  const newer={...payload,credential:{format:'codex-file',value:cache('profile-1@example.test',2)}} as SyncedAccount
  await mac.adapter.apply(id,newer,()=>true)
  assert.equal(await readFile(join(incoming.home,'auth.json'),'utf8'),cache('profile-1@example.test',1))
  await writeFile(join(incoming.home,'auth.json'),cache('profile-1@example.test',3))
  mac.busy.delete(incoming.id)
  const after=await mac.adapter.snapshot(()=>true)
  check('a fresher local refresh survives a credential update deferred while busy',()=>assert.equal(after.get(id)?.kind==='agent' ? after.get(id)?.credential?.value : null,cache('profile-1@example.test',3)))
  assert.equal(await readFile(join(incoming.home,'auth.json'),'utf8'),cache('profile-1@example.test',3))
  const isolated=await mac.adapter.snapshot(()=>true,'a-different-vault')
  check('a different Stoke vault starts independent account mappings',()=>assert.ok(!isolated.has(id)))
  assert.ok((await mac.adapter.snapshot(()=>true)).has(id))
  const external=join(root,'linked-auth.json'), beforeLink=cache('profile-1@example.test',3)
  await writeFile(external,beforeLink)
  await rm(join(incoming.home,'auth.json'));await symlink(external,join(incoming.home,'auth.json'))
  await assert.rejects(mac.adapter.apply(id,newer,()=>true),/linked login cache/)
  check('a linked credential cache cannot redirect an incoming write',()=>assert.equal(true,true))
  assert.equal(await readFile(external,'utf8'),beforeLink)
  await rm(join(incoming.home,'auth.json'));await writeFile(join(incoming.home,'auth.json'),beforeLink)
  await writeFile(join(wh.home,'config.toml'),'cli_auth_credentials_store = "keyring"\n')
  const keyring=await windows.adapter.snapshot(()=>true)
  check('keyring sign-ins sync profile details without scraping a stale file cache',()=>assert.equal(keyring.get(id)?.credential,null))
  await rm(join(wh.home,'config.toml'))
  await assert.rejects(mac.adapter.apply(id,payload,()=>false),/no longer enabled/)
  check('revoked consent leaves the existing login unchanged',()=>assert.equal(mac.get().accounts[incoming.id].home,incoming.home))
  const key=['owned','grok',Math.random().toString(36)].join('-')
  await windows.bots.change({kind:'manual',label:'Bot one',gatewayUrl:'https://gateway.cursor.sh',token:key,headers:{'x-owned-slot':'one'}})
  const withBot=await windows.adapter.snapshot(()=>true), bot=[...withBot].find(([,p])=>p.kind==='grok-bot')!
  mac.disable()
  await mac.adapter.apply(bot[0],bot[1],()=>true)
  const received=await mac.bots.exportForSync()
  check('a disabled Grok Bot plugin receives a re-sealed session without becoming enabled',()=>{assert.equal(received[0].credential.token,key);assert.equal(received[0].credential.headers['x-owned-slot'],'one')})
  await assert.rejects(mac.bots.operate({accountId:received[0].id,kind:'list'}),/Enable/)
  check('public plugin views never contain tokens or routing header values',()=>assert.ok(mac.publicViews.every(s=>!s.includes(key) && !s.includes('x-owned-slot'))))
  for(const box of [windows,mac]) {const name=(await readdir(box.ud)).find(n=>/^hub-accounts-.*\.json$/.test(n))!;const raw=await readFile(join(box.ud,name),'utf8');assert.ok(!raw.includes(key));assert.ok(!raw.includes('profile-1@example.test'));const parsed=JSON.parse(raw);assert.equal(typeof parsed.sealed,'string')}
  check('both account caches remain encrypted under independent device keys',()=>assert.equal(received.length,1))
  const reopened=new AccountSync({userData:mac.ud,root:accountsRoot(mac.home),trees:mac.trees,platform:'darwin',label:'Mac',backend:backend(),getSettings:mac.get,commit:()=>mac.get(),active:()=>false,grok:async()=>mac.bots,changed:()=>{}})
  await assert.rejects(reopened.snapshot(()=>true),/cannot be opened/)
  check('a copied local cache cannot be decrypted with another device key',()=>assert.ok(true))
  await mac.adapter.apply(id,null,()=>true)
  check('removal drops the selectable profile and preserves its native cache for running sessions',()=>assert.equal(!!mac.get().accounts[incoming.id],false))
  assert.equal(await readFile(join(incoming.home,'auth.json'),'utf8'),cache('profile-1@example.test',3))
  windows.bots.stop();mac.bots.stop()
  console.log(`\n${checks} account sync checks passed`)
} finally {await rm(root,{recursive:true,force:true})}
