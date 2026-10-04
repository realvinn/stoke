/*
 * The part of @xterm/addon-serialize that ScreenMirror uses, declared here
 * rather than taken from the package: its own typings import @xterm/xterm's,
 * which carry `/// <reference lib="dom"/>`, and the DOM's `fetch` types then
 * clash with node's across the whole main-process project (remote/push.ts
 * stopped typechecking). The module file has no imports of its own.
 */
declare module '@xterm/addon-serialize/lib/addon-serialize.mjs' {
  import type { ITerminalAddon, Terminal } from '@xterm/headless'

  export class SerializeAddon implements ITerminalAddon {
    activate(terminal: Terminal): void
    dispose(): void
    serialize(options?: { scrollback?: number; excludeModes?: boolean; excludeAltBuffer?: boolean }): string
  }
}
