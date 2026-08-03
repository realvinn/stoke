/*
 * Profiles are derived from the folders a machine actually has, and the first
 * version hardcoded one machine's layout — so a Mac organised any other way
 * matched nothing and showed no profiles at all. These cases are the layouts
 * that must keep working.
 *
 *   node scripts/verify-profiles.mts
 */
import { PROFILES, profileFor, profilesFor } from '../src/shared/profiles.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const counts = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o))
const ids = (o: Record<string, number>): string[] => profilesFor(counts(o)).map((p) => p.id)
const labels = (o: Record<string, number>): string[] => profilesFor(counts(o)).map((p) => p.label)

console.log('\nthe windows layout this was designed around')
check(
  'named folders are recognised, stray ones ignored',
  ids({ personal: 6, school: 3, 'gitea-company': 3, Documents: 2, WINDOWS: 1 }),
  ['personal', 'school', 'gitea-company']
)
check(
  'they keep their given order, not the folder count order',
  labels({ 'gitea-company': 9, personal: 1 }),
  ['Personal', 'Work']
)

console.log('\na machine organised some other way')
check(
  'unknown folders become profiles when nothing named matches',
  ids({ work: 5, side: 3, uni: 2 }),
  ['work', 'side', 'uni']
)
check('and are named readably', labels({ 'my-projects': 4, work: 2 }), ['My projects', 'Work'])
check(
  'a lone repo parked somewhere is not a category of work',
  ids({ work: 4, Downloads: 1, Desktop: 1 }),
  ['work']
)
check('no folders at all yields nothing rather than throwing', ids({}), [])
check('a single project overall yields nothing', ids({ Code: 1 }), [])

console.log('\none profile is still a choice')
check(
  'a mac with one work folder still gets a profile',
  ids({ Code: 4 }),
  ['Code']
)

console.log('\nlookup')
check('a known id resolves', profileFor('school')?.label, 'Study')
check('null resolves to nothing', profileFor(null), null)
check('an unknown id resolves to nothing rather than a wrong colour', profileFor('nope'), null)
check(
  'a derived id resolves against the derived list',
  profileFor('uni', profilesFor(counts({ uni: 3, work: 2 })))?.label,
  'Uni'
)

console.log('\ncolour contrast')
const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const lum = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

const derived = profilesFor(counts({ a: 2, b: 2, c: 2, d: 2 }))
for (const p of [...PROFILES, ...derived]) {
  const r = ratio(p.accent, p.accentContrast)
  const ok = r >= 4.5
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${p.label.padEnd(11)} ${r.toFixed(2)}:1`)
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
