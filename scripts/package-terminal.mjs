import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const dest = resolve(root, 'out/terminal-package')
mkdirSync(dest, { recursive: true })
mkdirSync(resolve(root, 'out/cli-release'), { recursive: true })
const entry = resolve(dest, 'stoke.cjs')
writeFileSync(entry, '#!/usr/bin/env node\n' + readFileSync(resolve(root, 'out/terminal/stoke.cjs'), 'utf8'))
chmodSync(entry, 0o755)
writeFileSync(resolve(dest, 'package.json'), JSON.stringify({
  name: '@realvinn/stoke-cli', version: pkg.version,
  description: 'A terminal unifier for your coding agents', license: pkg.license,
  bin: { stoke: 'stoke.cjs' }, engines: { node: '>=22.18.0' },
  files: ['stoke.cjs', 'README.md', 'LICENSE', 'THIRD-PARTY.txt'],
  dependencies: { '@lydell/node-pty': pkg.dependencies['@lydell/node-pty'] }
}, null, 2) + '\n')
writeFileSync(resolve(dest, 'LICENSE'), `MIT License

Copyright (c) 2026 ${pkg.author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`)
copyFileSync(resolve(root, 'docs/terminal.md'), resolve(dest, 'README.md'))
const licenses = ['zod', '@xterm/xterm', '@xterm/addon-unicode-graphemes', 'string-width', 'strip-ansi', 'ansi-regex', 'is-fullwidth-code-point', 'emoji-regex', 'cross-spawn', 'path-key', 'shebang-command', 'shebang-regex', 'which', 'isexe'].map((name) => {
  let directory = resolve(root, 'node_modules', name)
  try { directory = dirname(createRequire(resolve(root, 'node_modules/cross-spawn/package.json')).resolve(`${name}/package.json`)) } catch { /* root package */ }
  for (const file of ['LICENSE', 'LICENSE.txt', 'license', 'LICENSE-MIT.txt']) {
    try { return `${name}\n${readFileSync(resolve(directory, file), 'utf8')}\n` } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`Missing bundled dependency license: ${name}`)
})
writeFileSync(resolve(dest, 'THIRD-PARTY.txt'), 'The @xterm/xterm license below also covers @xterm/headless and @xterm/addon-serialize from the same project.\nCopyright (c) 2014-2024 The xterm.js authors.\n\n' + licenses.join('\n'))
console.log(`Standalone CLI package prepared at ${dest}`)
