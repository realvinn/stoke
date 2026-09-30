/*
 * Bundle the hub into ONE file a bare Node 24 runs, with `ws` inside it:
 *
 *   npm run build:hub            -> hub/dist/stoke-hub.mjs
 *   node hub/dist/stoke-hub.mjs serve
 *
 * The NUC then needs Node and this file, not a checkout or an npm install.
 * hub/dist/ is gitignored (`dist/`), and deliberately NOT under out/:
 * electron-builder packages `out/**`, so a hub bundle there would ship inside
 * every Stoke installer.
 *
 * Two settings are load-bearing:
 * - the `require` banner: `ws` is CommonJS, and esbuild's ESM output turns its
 *   `require('events')` into a helper that throws "Dynamic require of events is
 *   not supported" unless a real `require` is in scope;
 * - `bufferutil` and `utf-8-validate` external: ws loads them inside a
 *   try/catch as optional speed-ups, and neither is installed.
 *
 * verify:hub-server builds with `bundleOptions` into a temp dir and runs the
 * result, so this file cannot drift from what the suite proves.
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function bundleOptions(outfile) {
  return {
    entryPoints: [join(root, 'hub', 'server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: { js: "import { createRequire as __stokeHubRequire } from 'node:module'; const require = __stokeHubRequire(import.meta.url);" },
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning'
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outfile = process.argv[2] ?? join(root, 'hub', 'dist', 'stoke-hub.mjs')
  await build(bundleOptions(outfile))
  console.log(`built ${outfile}`)
}
