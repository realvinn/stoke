import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const OUT_DIR = resolve(__dirname, 'out/remote')
const PUBLIC_DIR = resolve(__dirname, 'src/remote/public')

/**
 * Stamps the phone shell's service worker (src/remote/public/sw.js, copied
 * into out/remote with the rest of public/) with this build's identity: BUILD,
 * a hash over every file the bundle wrote plus every public file, and
 * PRECACHE, the list of them. A new bundle is then a new sw.js — which is what
 * makes a browser install it, precache the new files under a cache named
 * after them, and drop the old build's. Fails the build if the markers are
 * gone, rather than ship a worker that silently never updates.
 */
function stampServiceWorker(): Plugin {
  return {
    name: 'stoke-stamp-service-worker',
    apply: 'build',
    // writeBundle, not generateBundle: vite's own HTML plugin adds index.html
    // to the bundle after a user plugin's generateBundle has run.
    writeBundle(_options, bundle) {
      const hash = createHash('sha256')
      const files = Object.keys(bundle).sort()
      for (const name of files) {
        const out = bundle[name]
        hash.update(name)
        hash.update(out.type === 'chunk' ? out.code : out.source)
      }
      const publicFiles = readdirSync(PUBLIC_DIR)
        .filter((n) => n !== 'sw.js' && !n.startsWith('.'))
        .sort()
      for (const name of publicFiles) {
        hash.update(name)
        hash.update(readFileSync(resolve(PUBLIC_DIR, name)))
      }
      const build = hash.digest('hex').slice(0, 12)
      const target = resolve(OUT_DIR, 'sw.js')
      const source = readFileSync(target, 'utf8')
      const BUILD_MARK = "'__STOKE_BUILD__'"
      const LIST_MARK = '/* __STOKE_PRECACHE__ */ []'
      if (!source.includes(BUILD_MARK) || !source.includes(LIST_MARK)) {
        throw new Error('sw.js lost its __STOKE_BUILD__ / __STOKE_PRECACHE__ markers; the phone shell would never update.')
      }
      const precache = [...files, ...publicFiles]
      writeFileSync(target, source.replace(BUILD_MARK, JSON.stringify(build)).replace(LIST_MARK, JSON.stringify(precache)))
    }
  }
}

/**
 * The phone UI is a plain web app, not an Electron surface, so it is built
 * separately from electron-vite's main/preload/renderer trio and served as
 * static files by the remote server.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/remote'),
  // Relative asset URLs, so it works no matter what path the tunnel serves it on.
  base: './',
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  plugins: [stampServiceWorker()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
    /*
     * One JS and one CSS file, named by their content: an /assets/ URL is then
     * one exact build forever, which is what lets the server mark it
     * immutable and the service worker keep it (`staticCacheControl`). The old
     * fixed names made every update a cache-invalidation problem.
     */
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
})
