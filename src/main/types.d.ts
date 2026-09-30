/** Vite's ?raw suffix imports a file's contents as a string. */
declare module '*?raw' {
  const source: string
  export default source
}

/**
 * electron-vite's ?modulePath suffix bundles the module as its own entry (a
 * worker thread's script) and imports the path it was written to.
 */
declare module '*?modulePath' {
  const path: string
  export default path
}
