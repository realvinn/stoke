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
  { id: 'lantern', name: 'Lantern', appearance: 'dark', hue: 80, tint: 1.4, black: true, accent: '#f7c948' },
  { id: 'graphite', name: 'Graphite', appearance: 'dark', hue: 0, tint: 0, black: true, accent: '#e8e8e8' },
  { id: 'lagoon', name: 'Lagoon', appearance: 'dark', hue: 200, tint: 1, pageChroma: 0.03, accent: '#4ecdc4' },
  { id: 'rose', name: 'Rosé', appearance: 'dark', hue: 350, tint: 1, pageChroma: 0.03, accent: '#f78ec1' },
  { id: 'ink', name: 'Ink', appearance: 'dark', hue: 250, tint: 1, pageChroma: 0.03, accent: '#7eb2ff' },
  { id: 'mist', name: 'Mist', appearance: 'light', hue: 200, tint: 2.5, pageChroma: 0.012, accent: '#0f766e' }
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
