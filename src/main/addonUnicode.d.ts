/** The headless-compatible addon, without importing the browser Terminal types. */
declare module '@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs' {
  export class UnicodeGraphemesAddon {
    activate(terminal: import('@xterm/headless').Terminal): void
    dispose(): void
  }
}
