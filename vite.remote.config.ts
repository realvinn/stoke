import { resolve } from 'node:path'
import { defineConfig } from 'vite'

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
  build: {
    outDir: resolve(__dirname, 'out/remote'),
    emptyOutDir: true,
    target: 'es2022',
    // One file each keeps the server's static handler trivial.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
})
