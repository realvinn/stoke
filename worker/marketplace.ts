import { PLUGIN_CATALOG } from '../src/shared/pluginPackages.ts'
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  )
const styles = `:root{color-scheme:dark;background:#181716;color:#e9e4dd;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}body{margin:0}main{max-width:1000px;margin:auto;padding:48px 24px 80px}a{color:inherit;text-underline-offset:4px}nav{display:flex;justify-content:space-between;gap:24px;font-size:14px;color:#b7afa4}nav a{text-decoration:none}header{margin:70px 0 45px;max-width:730px}.eyebrow{font:12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;color:#eaa879}h1{font-size:clamp(36px,6vw,66px);font-weight:550;letter-spacing:-.045em;line-height:1.08;margin:18px 0 24px}h2{font-size:23px;font-weight:550;letter-spacing:-.02em}p{line-height:1.65;color:#b7afa4}article{border-top:1px solid #3c3732;padding:28px 0;display:grid;grid-template-columns:1fr auto;gap:28px}article h2{margin:8px 0}article p{max-width:580px;margin:10px 0}small{color:#a79c90;font:12px ui-monospace,monospace}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.button{display:inline-block;padding:10px 16px;border:1px solid #6c5845;border-radius:7px;text-decoration:none;background:#2e241e;color:#f3d1b4;font-size:14px}.button:hover{background:#413026}.download{font-size:13px;color:#b7afa4}.note{font-size:13px;max-width:720px;border-left:2px solid #be8258;padding-left:18px}.developer{margin-top:45px;padding-top:26px;border-top:1px solid #3c3732}pre{background:#211e1a;border:1px solid #3c3732;border-radius:7px;padding:20px;overflow:auto;line-height:1.6;font-size:13px}code{font-family:ui-monospace,monospace}.docs{max-width:800px}.docs h2{margin-top:35px}.docs li{line-height:1.7;color:#b7afa4}.badge{display:inline-block;border:1px solid #5a4434;border-radius:99px;padding:5px 10px;font:12px ui-monospace,monospace;color:#eaa879}footer{border-top:1px solid #3c3732;margin-top:60px;padding-top:24px;color:#958b7e;font-size:13px}@media(max-width:650px){article{grid-template-columns:1fr}header{margin-top:48px}main{padding-top:28px}.actions{gap:15px}}`
function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Stoke</title><meta name="description" content="Native plugins and mods for Stoke. Create command panels, connect tools, and personalize your workspace."><style>${styles}</style></head><body><main><nav><a href="/">↟ Stoke</a><div><a href="/marketplace">Marketplace</a> &nbsp; / &nbsp; <a href="/marketplace/sdk">Developer guide</a></div></nav>${body}<footer>Stoke plugin API v1 · Curated packages · <a href="https://github.com/realvinn/stoke">Source on GitHub</a></footer></main></body></html>`
}
const homepage = document(
  'Marketplace',
  `<header><div class="eyebrow">Make Stoke yours</div><h1>A workspace that grows<br>with the way you work.</h1><p>Native panels, connections, and small mods. Add what you need, and switch it off when you don’t.</p><span class="badge">Plugin API preview</span></header><p class="note">Requires a Stoke build with Settings → Plugins. The published beta.6 does not include this API yet. Packages install disabled; review them before enabling. Command plugins run with your user permissions.</p>${PLUGIN_CATALOG.map(({ package: pkg, category, source }) => `<article><div><small>${escape(category)} / ${escape(pkg.version)}</small><h2>${escape(pkg.name)}</h2><p>${escape(pkg.description)}</p><small>By ${escape(pkg.author)} · ${pkg.kind === 'builtin' ? 'Native integration' : 'Local code + project context'}</small></div><div class="actions"><a class="button" href="stoke://plugins/install?id=${pkg.id}">Open in Stoke</a><a class="download" href="/marketplace/plugins/${pkg.id}.stoke-plugin.json">Download package</a><a class="download" href="${source}">View source ↗</a></div></article>`).join('')}<section class="developer"><div class="eyebrow">For builders</div><h2>Create a panel. Share a package.</h2><p>Start in Stoke’s plugin manager, edit a small JSON package, and run scripts through native buttons. Supported appearance values let you make mods without injecting arbitrary CSS.</p><a class="button" href="/marketplace/sdk">Read the developer guide</a></section>`
)
const guide = document(
  'Plugin developer guide',
  `<header><div class="eyebrow">Stoke plugin API v1</div><h1>Build something<br>for your workflow.</h1><p>API v1 provides native text panels, command actions, project context, and supported appearance values. It does not inject arbitrary renderer code.</p></header><div class="docs"><h2>1. Create a package</h2><p>Open Settings → Plugins → Create a plugin. Choose a unique lowercase ID, a name, and a source folder. Stoke writes an editable <code>.stoke-plugin.json</code> file and installs a disabled copy. You can also download the <a href="/marketplace/plugins/project-summary.stoke-plugin.json">Project summary example</a>.</p><h2>2. Define your panel</h2><pre>${escape(JSON.stringify({ format: 'stoke-plugin', apiVersion: 1, id: 'my-panel', version: '1.0.0', name: 'My panel', description: 'Run a command from a native panel.', author: 'Your name', kind: 'extension', permissions: ['local-code', 'project-context'], panel: { title: 'My panel', text: 'Choose a project, then run.', actions: [{ id: 'run', label: 'Run', entry: 'main.mjs', args: [] }] }, files: { 'main.mjs': "let text=''; for await (const chunk of process.stdin) text+=chunk;\nconst context=JSON.parse(text);\nconsole.log(context.project ?? 'No project selected');" }, appearance: {} }, null, 2))}</pre><h2>3. Run with native context</h2><p>Scripts use the Node runtime bundled with Stoke, run without a shell, and receive one JSON object on stdin: <code>{apiVersion, pluginId, dataDirectory, project}</code>. The project field is null unless <code>project-context</code> is declared and the user chooses a folder. Write plugin state inside dataDirectory. Print results to stdout; errors go to stderr. Static args are passed as separate arguments.</p><p>Commands run only after enabling the plugin and choosing an action. Each operation has a 60-second deadline and bounded output. Disabling or removing the plugin stops its owned commands. Keep child processes in the foreground; the extension API is not a service installer.</p><h2>Appearance mods</h2><p>Declare <code>appearance</code> and provide values for <code>--r-sm</code>, <code>--r-md</code>, <code>--r-lg</code>, <code>--r-card</code>, <code>--fs-sm</code>, or <code>--fs-md</code>. Values use px or rem. Disabling the mod removes its overrides. Files are text assets, not install scripts or HTML panels.</p><h2>Permissions and accounts</h2><p>Local scripts have your user permissions. These declarations describe intent; they are not an OS sandbox. Agent keys and logins are excluded from the child environment. API v1 does not expose Stoke credentials or support automatic account sync. The built-in Grok Bot integration seals explicitly imported sessions using the OS key store and never selects the desktop app’s current login during a command.</p><h2>Install, test, and share</h2><p>Import your edited JSON package in Settings → Plugins, review it, enable it, and run its actions. Export the package to share it. Packages may contain up to 64 text files, 24 actions, and 2 MB of text. IDs and asset paths must be portable across macOS, Windows and Linux.</p><p>The public directory is curated in <a href="https://github.com/realvinn/stoke/blob/windows-install/src/shared/pluginPackages.ts">Stoke’s catalog source</a>. To propose a marketplace entry, submit a repository pull request with the package, source link, license, and permissions. There is no unauthenticated upload or remote executable-code endpoint.</p></div>`
)
/** Exact namespace only: the existing shell/PowerShell installer routes stay intact. */
export function marketplaceResponse(request: Request): Response | null {
  const path = new URL(request.url).pathname
  if (path !== '/marketplace' && !path.startsWith('/marketplace/')) return null
  let body: string,
    type = 'text/html; charset=utf-8',
    status = 200
  const extra: Record<string, string> = {}
  if (path === '/marketplace' || path === '/marketplace/') body = homepage
  else if (path === '/marketplace/sdk' || path === '/marketplace/sdk/') body = guide
  else if (path === '/marketplace/catalog.json') {
    body = JSON.stringify({
      apiVersion: 1,
      packages: PLUGIN_CATALOG.map(({ package: pkg, category, source }) => ({
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        category,
        source,
        packageUrl: `https://stoke.vinn.dev/marketplace/plugins/${pkg.id}.stoke-plugin.json`
      }))
    })
    type = 'application/json; charset=utf-8'
  } else {
    const pkg = PLUGIN_CATALOG.find(
      (entry) => path === `/marketplace/plugins/${entry.package.id}.stoke-plugin.json`
    )?.package
    if (pkg) {
      body = JSON.stringify(pkg, null, 2) + '\n'
      type = 'application/json; charset=utf-8'
      extra['content-disposition'] = `attachment; filename="${pkg.id}.stoke-plugin.json"`
    } else {
      body = 'Marketplace page not found.\n'
      type = 'text/plain; charset=utf-8'
      status = 404
    }
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: {
      'content-type': type,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      ...extra
    }
  })
}
