/** Vite's ?raw suffix imports a file's contents as a string. */
declare module '*?raw' {
  const source: string
  export default source
}
