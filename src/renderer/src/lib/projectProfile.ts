/**
 * cwd → group → profile, for the renderer.
 *
 * A face over `@shared/paths`, not a second implementation: the sidebar chip
 * and the worklog gate must not be able to disagree about which folder belongs
 * to which group, and duplicating the longest-prefix rule here is how they
 * would start to.
 *
 * The body lives in `src/shared/paths.ts` rather than in this file because
 * this file resolves `@shared/*`, an alias only Vite and tsc understand — a
 * plain `node scripts/verify-*.mts` cannot load it, and an untested path rule
 * is how the gate got its longest-prefix bug in the first place.
 *
 * Pass `window.stoke.platform` as `platform`.
 */
export { profileIdForCwd, type GroupOwner } from '@shared/paths'
export { profileFor, type ResolvedProfile } from '@shared/profiles'
