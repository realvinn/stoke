/*
 * Whether the `stoke` command is installed, and what may be done about it.
 *
 * The rules live here, pure, because three places have to agree on them and
 * two of those are shell scripts: `build/bin/stoke`'s own `install-cli`, the
 * one-line installer (which calls that), and Settings > Updates > Command line
 * (`src/main/stokeCommand.ts`, which does the file work with async fs).
 * `verify:stoke-args` runs the shim against the same fixtures it hands these
 * functions and fails when they disagree.
 *
 * The rule that matters most is the one about NOT touching things: a
 * `~/.local/bin/stoke` that is not a link into some Stoke.app is somebody
 * else's — a Homebrew formula, a script of the user's own, an older Linux
 * AppImage copied over by hand — and is never replaced or deleted.
 *
 * No `node:` import (gotcha 27): compiled for the renderer too.
 */

/**
 * A symlink target that is some Stoke bundle's copy of the shim.
 *
 * Any bundle, not only this one: a link to a Stoke.app that has since moved,
 * been replaced, or been deleted is still Stoke's to re-point. Deliberately the
 * same test as the shim's `case *.app/Contents/Resources/bin/stoke`, where `*`
 * matches `/` as well.
 */
export function isStokeShimTarget(target: string): boolean {
  return /\.app\/Contents\/Resources\/bin\/stoke$/.test(target)
}

/** What is at `~/.local/bin/stoke`, as `lstat` + `readlink` saw it. */
export type LinkEntry =
  | { kind: 'missing' }
  | { kind: 'link'; target: string }
  /** A regular file, a directory, anything that is not a symlink. */
  | { kind: 'other' }

export type LinkStatus =
  /** A link to this build's own shim. */
  | 'installed'
  /** A link to another Stoke bundle's shim, or to one that is gone. Install re-points it. */
  | 'repairable'
  /** Not Stoke's. Never touched. */
  | 'foreign'
  | 'missing'

export function classifyMacLink(entry: LinkEntry, shimPath: string): LinkStatus {
  if (entry.kind === 'missing') return 'missing'
  if (entry.kind === 'other') return 'foreign'
  if (entry.target === shimPath) return 'installed'
  return isStokeShimTarget(entry.target) ? 'repairable' : 'foreign'
}

/** `…/Stoke.app/Contents/Resources/bin/stoke` → `…/Stoke.app`, or null if it is not that shape. */
export function appOfShim(shimPath: string): string | null {
  const m = /^(.*\.app)\/Contents\/Resources\/bin\/stoke$/.exec(shimPath)
  return m ? m[1] : null
}

/**
 * Why this bundle cannot be linked to, or null.
 *
 * Both cases are copies that will not be there tomorrow, and a link to them
 * would be a `stoke` that works today and prints "no such file" after the next
 * restart. The shim's `bundle_problem` makes the same two calls.
 *
 * `/Volumes/<disk image>/Stoke.app` is refused and `/Volumes/<disk>/Applications/
 * Stoke.app` is not: a dmg mounts with the app at its root, and an app kept on
 * an external drive almost never is.
 */
export function macBundleProblem(appPath: string): string | null {
  if (appPath.includes('/AppTranslocation/')) {
    return 'macOS is running this Stoke from a temporary copy (App Translocation), which disappears on restart. Move Stoke.app into /Applications and open it from there.'
  }
  if (/^\/Volumes\/[^/]+\/[^/]+$/.test(appPath)) {
    return 'This Stoke is running from its disk image, which will be ejected. Drag it into /Applications and open it from there.'
  }
  return null
}

/**
 * Whether `dir` is on a PATH value, or null when there is no PATH to ask.
 *
 * The PATH that matters is the one a NEW terminal gets — the login shell's,
 * which `src/main/cli.ts` probes — not Stoke's own, which for a Finder launch
 * is `/usr/bin:/bin:/usr/sbin:/sbin` and never contains anything interesting.
 * A trailing separator is ignored on both sides; Windows compares
 * case-insensitively and splits on `;`.
 */
export function dirOnPath(dir: string, pathValue: string | null, platform: string): boolean | null {
  if (pathValue === null) return null
  const win = platform === 'win32'
  const norm = (p: string): string => {
    const t = p.trim().replace(win ? /[\\/]+$/ : /\/+$/, '')
    return win ? t.toLowerCase() : t
  }
  const want = norm(dir)
  if (!want) return false
  return pathValue
    .split(win ? ';' : ':')
    .some((entry) => entry !== '' && norm(entry) === want)
}

/** The line a shell profile needs when `~/.local/bin` is not on PATH. */
export const PATH_EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"'

/**
 * The comment under the shebang of the launcher `install/install.sh` writes on
 * Linux. Read back to tell that launcher from anything else at
 * `~/.local/bin/stoke`; `verify:install` asserts the shipped one still carries it.
 */
export const LINUX_WRAPPER_MARK = "# Stoke's launcher."

export type LinuxCommand = 'wrapper' | 'appimage' | 'foreign' | 'missing'

/**
 * What the first bytes of `~/.local/bin/stoke` say it is, on Linux. `null` is
 * "not there". An ELF there is the installer's older layout, where the AppImage
 * itself was the command: it runs, but it cannot take a folder.
 */
export function classifyLinuxCommand(head: string | null): LinuxCommand {
  if (head === null) return 'missing'
  if (head.startsWith('\u007fELF')) return 'appimage'
  if (head.startsWith('#!') && head.includes(LINUX_WRAPPER_MARK)) return 'wrapper'
  return 'foreign'
}
