/**
 * Profiles: which slice of the machine you are looking at.
 *
 * A profile is a **view filter and nothing more**. Every profile can reach
 * every file and every project — you can always open Claude's history, point at
 * any directory, and start or resume a chat anywhere. The point is that sitting
 * in a lecture you are not looking at work from somewhere else.
 *
 * They key off `Project.group`, which is already the parent folder's name, and
 * those folders already carry separate git identities (see G:/Code/CLAUDE.md).
 * So the grouping is not invented here — it is the one the machine already has.
 */

export interface Profile {
  /** Matches `Project.group`, the parent folder name. */
  id: string
  label: string
  /** Replaces the theme accent while this profile is active. */
  accent: string
  accentHover: string
  accentSoft: string
  /** Text drawn on top of the accent. Must clear 4.5:1 against it. */
  accentContrast: string
  /**
   * A second colour for profiles that carry one. Only Study does; it marks the
   * chip so the two academic-looking profiles never blur together at a glance.
   */
  secondary?: string
}

export const PROFILES: Profile[] = [
  {
    id: 'personal',
    label: 'Personal',
    // Unchanged: this is the app's own accent, and personal work is the default
    // register the theme was designed around.
    accent: '#ff9552',
    accentHover: '#ffab74',
    accentSoft: 'rgba(255, 149, 82, 0.14)',
    accentContrast: '#1a1108'
  },
  {
    id: 'school',
    label: 'Study',
    // Red, paired with blue. Kept lighter than the danger token so a profile
    // never reads as an error state.
    accent: '#ff6b6b',
    accentHover: '#ff8a8a',
    accentSoft: 'rgba(255, 107, 107, 0.14)',
    accentContrast: '#1a0d0d',
    secondary: '#6ea8fe'
  },
  {
    id: 'gitea-company',
    label: 'Work',
    accent: '#5fd08a',
    accentHover: '#83deA5',
    accentSoft: 'rgba(95, 208, 138, 0.14)',
    accentContrast: '#08170f'
  },
  {
    id: 'gitea-vibe',
    label: 'Vibe',
    accent: '#b48ef7',
    accentHover: '#c8aaf9',
    accentSoft: 'rgba(180, 142, 247, 0.14)',
    accentContrast: '#140b1f'
  }
]

export function profileFor(id: string | null): Profile | null {
  if (!id) return null
  return PROFILES.find((p) => p.id === id) ?? null
}
