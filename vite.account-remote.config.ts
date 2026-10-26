import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
const hub = resolve('src/main/hub')
export default defineConfig({
  root: resolve('src/accountRemote'), base: '/remote/', publicDir: false,
  plugins: [{ name: 'stoke-browser-crypto', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !importer.startsWith(hub)) return
    const path = resolve(dirname(importer), source)
    if (path === resolve(hub, 'crypto.ts')) return resolve('src/accountRemote/crypto.ts')
    if (path === resolve('src/main/remote/socket.ts')) return resolve('src/accountRemote/virtualSocket.ts')
  } }],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: { outDir: resolve('out/account-remote/remote'), emptyOutDir: true, target: 'es2022', sourcemap: false }
})
