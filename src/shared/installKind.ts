/*
 * How this copy of Stoke got onto the machine, and therefore how it updates.
 *
 * On Windows electron-updater has exactly one idea: it constructs an
 * `NsisUpdater` whatever the copy is (electron-updater/out/main.js:44-45),
 * downloads the NSIS installer and runs it with `--updated /S`. That is right
 * for a copy the installer put down — the website download, the one-line
 * installer, winget and Chocolatey all run that same installer — and wrong for
 * everything else. A folder unzipped onto the Desktop "updated" by installing a
 * SECOND copy under %LOCALAPPDATA%\Programs (multiUser.nsh picks the registry's
 * InstallLocation or that default, never the folder the update was started
 * from) and launching that, while the unzipped copy stayed on the old version
 * and offered the same update again on its next start, forever. A copy Scoop
 * manages would have been overwritten behind Scoop's back.
 *
 * So the kind is decided first, and each kind gets an honest route:
 *
 *   installer  the NSIS installer's folder — electron-updater, unchanged.
 *   portable   any other folder Stoke can write beside — Stoke downloads the
 *              portable zip, unpacks it next to itself and swaps the folder
 *              when it quits (src/main/portableUpdate.ts).
 *   managed    a package manager's own folder — its update command, shown,
 *              never run behind its back.
 *   manual     a copy that cannot replace itself (a read-only folder, the
 *              single-file portable exe) — the releases page, and why.
 *   source     a development run: nothing installed to replace.
 *
 * Pure and dependency-free — no `node:` import, because src/shared is compiled
 * for the renderer too (gotcha 27) — so the whole decision is a function of the
 * facts main gathers, and verify:portable holds every branch of it. Paths are
 * compared as Windows compares them: case-insensitively, either slash.
 */

export type InstallKindId = 'installer' | 'portable' | 'managed' | 'manual' | 'source'

export interface InstallKind {
  kind: InstallKindId
  /** The folder Stoke.exe runs from, when it matters to the reader (portable, manual). */
  dir: string | null
  /** Which package manager, for `managed`. */
  manager: 'scoop' | 'winget' | 'chocolatey' | null
  /** The command that updates this copy, for `managed`. */
  command: string | null
  /**
   * One sentence for Settings › Updates, or null when there is nothing to add to
   * what that panel already says (the installer, macOS, Linux).
   */
  note: string | null
}

/** What main knows about this process, gathered in src/main/selfUpdate.ts. */
export interface InstallFacts {
  platform: string
  /** `app.isPackaged`. */
  packaged: boolean
  /** `process.execPath` — Stoke.exe itself. */
  execPath: string
  /** The handful of environment variables the classification reads. */
  env: {
    PORTABLE_EXECUTABLE_FILE?: string
    LOCALAPPDATA?: string
    USERPROFILE?: string
    SCOOP?: string
    SCOOP_GLOBAL?: string
    ProgramData?: string
    ChocolateyInstall?: string
  }
  /**
   * Whether `Uninstall Stoke.exe` sits beside Stoke.exe. The NSIS installer
   * writes it into $INSTDIR and nothing else does — not the portable zip, not a
   * copied folder, not 7-Zip unpacking the installer — so it is the one fact
   * that separates "the installer put this here" from everything else without
   * trusting a registry key that may name a different copy.
   */
  hasUninstaller: boolean
  /**
   * Whether Stoke can create a folder beside its own, which is what the portable
   * swap needs (the new copy is unpacked next to the old one, on the same
   * volume, so the swap is two renames). Null when it could not be tested.
   */
  canWriteBeside: boolean | null
}

/** The electron-builder `productName`; its uninstaller is `Uninstall ${productName}.exe`. */
export const PRODUCT_NAME = 'Stoke'
export const UNINSTALLER_NAME = `Uninstall ${PRODUCT_NAME}.exe`
export const RELEASES_URL = 'https://github.com/realvinn/stoke/releases/latest'

/** A path as Windows compares it: one kind of slash, no trailing one, one case. */
export function winPathKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** The folder a Windows path is in. Not node:path — this file is shared with the renderer. */
export function winDirname(p: string): string {
  const n = p.replace(/\//g, '\\').replace(/\\+$/, '')
  const at = n.lastIndexOf('\\')
  return at <= 0 ? n : n.slice(0, at)
}

/** Whether `child` is `parent` or anywhere beneath it. */
export function winIsUnder(child: string, parent: string): boolean {
  const c = winPathKey(child)
  const p = winPathKey(parent)
  return p.length > 0 && (c === p || c.startsWith(p + '\\'))
}

/**
 * The first path segment below `root` on the way to `child`, in its original
 * case — `scoop\apps\<name>\current\Stoke.exe` gives `<name>`.
 */
function segmentBelow(child: string, root: string): string | null {
  const c = child.replace(/\//g, '\\')
  const rest = c.slice(winPathKey(root).length).replace(/^\\+/, '')
  const seg = rest.split('\\')[0]
  return seg ? seg : null
}

function managed(manager: 'scoop' | 'winget' | 'chocolatey', command: string, who: string): InstallKind {
  return {
    kind: 'managed',
    dir: null,
    manager,
    command,
    note: `Installed by ${who}, which keeps its own record of what version is here, so Stoke leaves updating to it. Run: ${command}`
  }
}

/**
 * The classification. Order matters and each step says why it is where it is.
 */
export function classifyInstall(f: InstallFacts): InstallKind {
  const none = { dir: null, manager: null, command: null, note: null }
  if (!f.packaged) return { kind: 'source', ...none }
  // macOS and Linux have one route each and electron-updater already takes it:
  // Squirrel swaps the .app wherever it is, AppImageUpdater replaces $APPIMAGE.
  if (f.platform !== 'win32') return { kind: 'installer', ...none }

  const dir = winDirname(f.execPath)
  const env = f.env

  // 1. electron-builder's single-file `portable` target. It unpacks itself into
  //    %TEMP% on every launch (templates/nsis/portable.nsi) and holds its own exe
  //    open while the app runs, so there is no folder to swap and no file that can
  //    be replaced from inside. Stoke does not ship one; a copy somebody built is
  //    told the truth rather than handed an installer it never asked for.
  if (env.PORTABLE_EXECUTABLE_FILE) {
    return {
      kind: 'manual',
      dir: winDirname(env.PORTABLE_EXECUTABLE_FILE),
      manager: null,
      command: null,
      note: `This is a single-file portable build, which cannot replace itself while it runs. Download the new version from ${RELEASES_URL}.`
    }
  }

  // 2-4. A package manager's OWN folder, before the installer test, because a
  //      Scoop manifest may unpack the NSIS installer with 7-Zip and keep its
  //      pieces (an uninstaller included) under apps\. Each of these folders
  //      carries the manager's record of the installed version, which an update
  //      from inside would silently falsify. A manager that merely RUNS the
  //      installer (winget with Stoke's own manifest; a Chocolatey package that
  //      wraps the .exe) puts Stoke in the installer's folder, not its own, and
  //      lands on `installer` below — which is right: the installer rewrites
  //      the Apps & Features entry those managers read the version from.
  const scoopRoots = [env.SCOOP, env.USERPROFILE ? `${env.USERPROFILE}\\scoop` : undefined, env.SCOOP_GLOBAL, env.ProgramData ? `${env.ProgramData}\\scoop` : undefined]
  for (const root of scoopRoots) {
    if (!root) continue
    const apps = `${root}\\apps`
    if (winIsUnder(dir, apps)) return managed('scoop', `scoop update ${segmentBelow(dir, apps) ?? 'stoke'}`, 'Scoop')
  }
  if (env.LOCALAPPDATA) {
    // winget's own portable/zip installs. Stoke's winget package uses the NSIS
    // installer instead, which lands as `installer` below and updates itself;
    // this is for a manifest somebody else writes with InstallerType: zip.
    const packages = `${env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages`
    if (winIsUnder(dir, packages)) {
      const folder = segmentBelow(dir, packages) ?? ''
      // `<PackageIdentifier>_<SourceName>_<hash>`; identifiers never contain `_`.
      const id = folder.split('_')[0] || 'realvinn.Stoke'
      return managed('winget', `winget upgrade --id ${id}`, 'winget')
    }
  }
  const chocoRoots = [env.ChocolateyInstall, env.ProgramData ? `${env.ProgramData}\\chocolatey` : undefined]
  for (const root of chocoRoots) {
    if (!root) continue
    const lib = `${root}\\lib`
    if (winIsUnder(dir, lib)) return managed('chocolatey', `choco upgrade ${segmentBelow(dir, lib) ?? 'stoke'}`, 'Chocolatey')
  }

  // 5. The NSIS installer's folder, from the website, the one-liner or winget.
  if (f.hasUninstaller) return { kind: 'installer', ...none }

  // 6. Anything else is a folder somebody put there: the portable zip, or a copy.
  if (f.canWriteBeside === false) {
    return {
      kind: 'manual',
      dir,
      manager: null,
      command: null,
      note: `Stoke is running from ${dir}, and it cannot create files beside that folder without administrator rights, so it cannot replace itself. Move the folder somewhere you own, or download the new version from ${RELEASES_URL}.`
    }
  }
  return {
    kind: 'portable',
    dir,
    manager: null,
    command: null,
    note: `Portable copy in ${dir}. An update is unpacked beside it and swapped in when Stoke restarts or quits; your settings and sessions live elsewhere and are not touched.`
  }
}

/** One file listed in an update manifest, as electron-updater's UpdateInfo carries it. */
export interface ManifestFile {
  url: string
  sha512: string
  size?: number
}

/**
 * The portable zip for this architecture out of a release's `latest.yml`.
 *
 * The same preference electron-updater's own `findFile` applies to the
 * installer (Provider.js:79-80): filter by kind, then prefer the file naming
 * this process's arch. Stricter in one way, on purpose: `findFile` falls back to
 * the first match when none names the arch, which on an arm64 machine would
 * swap in an x64 folder. An installer running under emulation is survivable; a
 * folder whose terminal binary is for the wrong CPU is every tab dead
 * (gotcha 67). No zip for this arch is null — "this release has no portable
 * build for you" — never a guess.
 */
export function portableAssetFor(files: readonly ManifestFile[], arch: string): ManifestFile | null {
  const zips = files.filter((f) => /-win\.zip$/i.test(f.url))
  return zips.find((f) => new RegExp(`-${arch}-win\\.zip$`, 'i').test(f.url)) ?? null
}

/** Whether a SelfUpdate state for this kind may download through electron-updater (the NSIS route). */
export function usesInstallerRoute(kind: InstallKindId): boolean {
  return kind === 'installer'
}
