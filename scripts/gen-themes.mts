/*
 * Print a built-in theme as the TypeScript literal `themes.ts` checks in.
 *
 *   node scripts/gen-themes.mts lantern
 *   node scripts/gen-themes.mts --all
 *
 * themes.ts has always said every hex in it was generated and told the reader to
 * "regenerate" — and there was nothing to run. This is that program. The hexes
 * are still checked in rather than computed at boot, so nothing at runtime
 * depends on the colour maths and a diff shows what actually changed on screen;
 * `verify:theme-gen` then asserts each built-in regenerates byte-identically
 * from the seed it carries, so a hand-edited hex fails check.
 *
 * The seed table for the shipped themes lives on the themes themselves
 * (`Theme.seed`). New candidates go in NEW_SEEDS below until they are pasted in,
 * after which they too are read from `BUILT_IN_THEMES`.
 */
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
import { buildTheme, contrastReport } from '../src/shared/themeGen.ts'
import type { Theme, ThemeSeed } from '../src/shared/types.ts'

const NEW_SEEDS: ThemeSeed[] = [
  { id: 'hearth', name: 'Hearth', appearance: 'dark', hue: 38, tint: 1.2, pageChroma: 0.028, accent: '#e87850' },
  { id: 'dusk', name: 'Dusk', appearance: 'dark', hue: 292, tint: 1, pageChroma: 0.03, accent: '#c49bff' },
  { id: 'harbor', name: 'Harbor', appearance: 'dark', hue: 215, tint: 1, pageChroma: 0.028, accent: '#5ba4d9' },
  { id: 'cinder', name: 'Cinder', appearance: 'dark', hue: 18, tint: 0.8, black: true, pageChroma: 0.02, accent: '#ff7a6a' },
  { id: 'frost', name: 'Frost', appearance: 'light', hue: 225, tint: 2.2, pageChroma: 0.014, accent: '#1d4ed8' },
  { id: 'meadow', name: 'Meadow', appearance: 'light', hue: 142, tint: 2, pageChroma: 0.014, accent: '#2f6b3c' }
]

function literal(constName: string, t: Theme, doc: string): string {
  const seed = t.seed!
  const q = (v: string): string => `'${v}'`
  const kv = (o: Record<string, string>, indent: string): string =>
    Object.entries(o)
      .map(([k, v]) => `${indent}${k}: ${q(v)}`)
      .join(',\n')
  const seedParts = [
    `id: ${q(seed.id)}`,
    `name: ${q(seed.name)}`,
    `appearance: ${q(seed.appearance)}`,
    `hue: ${seed.hue}`,
    `tint: ${seed.tint}`,
    ...(seed.pageChroma ? [`pageChroma: ${seed.pageChroma}`] : []),
    ...(seed.black ? ['black: true'] : []),
    `accent: ${q(seed.accent)}`,
    ...(seed.overrides
      ? [
          `overrides: { ${Object.entries(seed.overrides)
            .map(([k, v]) => `${k}: ${q(v as string)}`)
            .join(', ')} }`
        ]
      : [])
  ]
  return `/**
${doc
  .split('\n')
  .map((l) => ` * ${l}`.trimEnd())
  .join('\n')}
 */
export const ${constName}: Theme = {
  id: ${q(t.id)},
  name: ${q(t.name)},
  appearance: ${q(t.appearance)},
  builtIn: true,
  seed: {
    ${seedParts.join(',\n    ')}
  },
  colors: {
${kv(t.colors as unknown as Record<string, string>, '    ')}
  },
  terminal: {
${kv(t.terminal as unknown as Record<string, string>, '    ')}
  }
}
`
}

const want = process.argv[2]
const all = want === '--all'
const seeds = [...BUILT_IN_THEMES.map((t) => t.seed!).filter(Boolean), ...NEW_SEEDS]
for (const seed of seeds) {
  if (!all && seed.id !== want) continue
  const t = buildTheme(seed)
  const findings = contrastReport(t.colors, t.appearance)
  if (findings.length) {
    console.error(
      `# ${seed.id}: ${findings.map((f) => `${String(f.token)} ${f.measured.toFixed(2)} < ${f.floor}`).join(', ')}`
    )
  }
  console.log(literal(seed.id.toUpperCase().replace(/-/g, '_'), t, `Generated from its seed by scripts/gen-themes.mts.`))
}
if (!all && !seeds.some((s) => s.id === want)) {
  console.error(`no seed named ${want}; known: ${seeds.map((s) => s.id).join(', ')}`)
  process.exitCode = 2
}
