import { defineConfig, normalizePath } from 'vite'
import { dirname, resolve } from 'node:path'
// Vite importer IDs use forward slashes even on Windows.
const hub = normalizePath(resolve('src/main/hub'))
export default defineConfig({
  root: resolve('src/accountRemote'), base: '/remote/', publicDir: false,
  plugins: [{ name: 'stoke-browser-crypto', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !normalizePath(importer).startsWith(hub + '/')) return
    const path = normalizePath(resolve(dirname(importer), source))
    if (path === hub + '/crypto.ts') return normalizePath(resolve('src/accountRemote/crypto.ts'))
    if (path === normalizePath(resolve('src/main/remote/socket.ts'))) return normalizePath(resolve('src/accountRemote/virtualSocket.ts'))
  } }],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: { outDir: resolve('out/account-remote/remote'), emptyOutDir: true, target: 'es2022', sourcemap: false }
})
