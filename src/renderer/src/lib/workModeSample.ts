/**
 * Work mode's fallback: a bundled, original "slightly complicated website"
 * (Fernway Outfitters, an outdoor-gear shop), typed when the tab in front has
 * no project or nothing of the picked types could be read.
 *
 * Imported only by the Work mode chunk (`?raw`, so the files are strings in
 * that chunk and nothing else), never by App: a static import would put ~40 KB
 * of sample text into every launch's bundle (gotcha 40's boot-cost rule, one
 * process over).
 */
import indexHtml from '../assets/workModeSample/index.html?raw'
import stylesCss from '../assets/workModeSample/styles.css?raw'
import appJs from '../assets/workModeSample/app.js?raw'
import cartJs from '../assets/workModeSample/js/cart.js?raw'
import apiJs from '../assets/workModeSample/js/api.js?raw'
import {
  countTypes,
  defaultPicks,
  extOf,
  orderPicks,
  type WorkModeFile,
  type WorkModeOptions,
  type WorkModeSource
} from '../../../shared/workMode.ts'

export const SAMPLE_PROJECT = { name: 'fernway-store', branch: 'main', toolchain: 'vite' } as const

/** In reading order: the left editor types app.js and its modules, the right the style sheet, then the page. */
export const SAMPLE_FILES: readonly WorkModeFile[] = [
  { path: 'app.js', text: appJs },
  { path: 'styles.css', text: stylesCss },
  { path: 'js/cart.js', text: cartJs },
  { path: 'index.html', text: indexHtml },
  { path: 'js/api.js', text: apiJs }
].map((f) => ({ path: f.path, ext: extOf(f.path), text: f.text.replace(/\r\n?/g, '\n'), eol: 'LF' as const }))

const SAMPLE_TREE = ['js/', 'public/', 'app.js', 'index.html', 'styles.css', 'js/api.js', 'js/cart.js', 'README.md', 'package.json', 'vite.config.js', 'public/robots.txt']

/** The sample as a source: the picks kept if they are the sample's own types (most-used first, `orderPicks`), else its defaults. */
export function sampleSource(options: WorkModeOptions, picks: readonly string[] = []): WorkModeSource {
  const types = countTypes(SAMPLE_FILES.map((f) => f.path))
  const kept = orderPicks(picks, types)
  const chosen = kept.length ? kept : defaultPicks(types)
  const files = SAMPLE_FILES.filter((f) => chosen.includes(f.ext))
  return {
    project: { ...SAMPLE_PROJECT },
    reason: null,
    types,
    picks: chosen,
    options,
    files: files.length ? [...files] : [...SAMPLE_FILES],
    tree: SAMPLE_TREE
  }
}
