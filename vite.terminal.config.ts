import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

export default defineConfig({
  define: { STOKE_TERMINAL_VERSION: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  resolve: { alias: { '@xterm/headless': resolve('node_modules/@xterm/headless/lib-headless/xterm-headless.js') } },
  build: {
    target: 'node22',
    outDir: 'out/terminal',
    lib: { entry: 'src/terminal/index.ts', formats: ['cjs'], fileName: () => 'stoke.cjs' },
    rollupOptions: { external: (id) => builtins.has(id) || id === '@lydell/node-pty', output: { inlineDynamicImports: true } }
  }
})
