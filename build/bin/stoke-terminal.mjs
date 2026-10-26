#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Local npm link works before building; releases use the bundled entry.
const built = new URL('../../out/terminal/stoke.cjs', import.meta.url)
await import(existsSync(fileURLToPath(built)) ? built.href : new URL('../../src/terminal/index.ts', import.meta.url).href)
