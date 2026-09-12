/**
 * The `Text` module rule in `wrangler.jsonc` turns these three files into
 * strings at bundle time. This tells an editor the same thing.
 *
 * `worker/` is in neither tsconfig — it needs `@cloudflare/workers-types`,
 * which is not a dependency of this repo — so nothing here is typechecked by
 * `npm run typecheck`. `worker/route.ts`, which is the only file with a
 * decision in it, imports nothing and is exercised by `npm run verify:install`
 * instead.
 */
declare module '*.sh' {
  const content: string
  export default content
}
declare module '*.ps1' {
  const content: string
  export default content
}
declare module '*.html' {
  const content: string
  export default content
}
