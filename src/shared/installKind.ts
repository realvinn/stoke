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
 *   portable   a folder of Stoke's own that Stoke can write beside — Stoke
 *              downloads the portable zip, unpacks it next to itself and swaps
 *              the folder when it quits (src/main/portableUpdate.ts).
 *   managed    a package manager's own folder — its update command, shown,
 *              never run behind its back.
 *   manual     a copy that must not replace itself — a folder it shares with
 *              other files, a read-only folder, a drive root, the single-file
 *              portable exe, or a probe that could not answer — the releases
 *              page, and why.
 *   source     a development run: nothing installed to replace.
 *
 * The portable swap renames the WHOLE folder Stoke.exe sits in, so "portable"
 * is only ever the answer for a folder that holds nothing but Stoke: 7-Zip's
 * "Extract Here" into Downloads would otherwise have made Downloads the thing
 * renamed aside and, a minute later, deleted (found by review, reproduced with
 * the real helper). And a probe that timed out never produces the destructive
 * route: its answer is `manual`, unsettled, and it is asked again.
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
  /**
   * False when a probe could not answer (it timed out behind a busy disk or
   * thread pool), so the answer is a cautious `manual` and must not be
   * remembered: the next check asks again. True for every definite answer.
   */
  settled: boolean
}

/** What main knows about this process, gathered in src/main/portableUpdate.ts. */
export interface InstallFacts {
  platform: string
  /** `app.isPackaged`. */
  packaged: boolean
  /** Stoke.exe, resolved through junctions and symlinks — where a swap would act. */
  execPath: string
  /**
   * `process.execPath` as the process was started, before `realpath`. A package
   * manager's root is compared against both: its folder may sit behind a
   * junction that resolves somewhere its environment variable does not name.
   */
  execPathRaw?: string
  /** The handful of environment variables the classification reads. */
  env: {
    PORTABLE_EXECUTABLE_FILE?: string
    LOCALAPPDATA?: string
    USERPROFILE?: string
    SCOOP?: string
    SCOOP_GLOBAL?: string
    ProgramData?: string
    ChocolateyInstall?: string
    TEMP?: string
    TMP?: string
  }
  /**
   * Whether `Uninstall Stoke.exe` sits beside Stoke.exe — the NSIS installer
   * writes it into $INSTDIR, and the portable zip carries none. Null when the
   * probe could not answer in time, which must never be read as "no".
   *
   * (A copy of an installed folder carries the uninstaller too, and so takes
   * the installer route — which updates the ORIGINAL folder. That is how every
   * copy behaved before the portable route existed; copying an installed
   * program's folder is rare, and the registry that could tell the two apart is
   * not read here.)
   */
  hasUninstaller: boolean | null
  /**
   * Whether Stoke can create a folder beside its own, which the portable swap
   * needs (the new copy is unpacked next to the old one, on the same volume, so
   * the swap is two renames). Null when it could not be tested in time.
   */
  canWriteBeside: boolean | null
  /** Why that test failed (the errno code, e.g. `EACCES`, `EROFS`), or null. */
  writeError?: string | null
  /**
   * The names at the top of the folder Stoke.exe runs from, or null when they
   * could not be read in time. Anything that is not part of a Stoke build means
   * the folder is shared, and a swap would carry it away.
   */
  entries: readonly string[] | null
}

/** The electron-builder `productName`; its uninstaller is `Uninstall ${productName}.exe`. */
export const PRODUCT_NAME = 'Stoke'
export const UNINSTALLER_NAME = `Uninstall ${PRODUCT_NAME}.exe`
export const RELEASES_URL = 'https://github.com/realvinn/stoke/releases/latest'

/**
 * A path as Windows compares it: one kind of slash, no repeated or trailing
 * one (a hand-set `SCOOP=D:\scoop\` plus `\apps` would otherwise never match),
 * one case. A UNC path keeps its leading `\\`.
 */
export function winPathKey(p: string): string {
  const s = p.replace(/\//g, '\\')
  const unc = s.startsWith('\\\\')
  const body = s.replace(/\\{2,}/g, '\\').replace(/\\+$/, '')
  return ((unc ? '\\' : '') + body).toLowerCase()
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

/** A drive root (`E:`, `E:\`) or a bare share (`\\server\share`), which has no folder to swap. */
export function isVolumeRoot(dir: string): boolean {
  const s = dir.replace(/\//g, '\\').replace(/\\+$/, '')
  return /^[A-Za-z]:$/.test(s) || /^\\\\[^\\]+\\[^\\]+$/.test(s)
}

/**
 * The first path segment below `root` on the way to `child`, in its original
 * case — `scoop\apps\<name>\current\Stoke.exe` gives `<name>`.
 */
function segmentBelow(child: string, root: string): string | null {
  const c = winPathKey(child)
  const r = winPathKey(root)
  if (!c.startsWith(r)) return null
  // Offsets are identical in the key and in the separator-normalised original.
  const original = child.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
  const rest = original.slice(r.length).replace(/^\\+/, '')
  const seg = rest.split('\\')[0]
  return seg ? seg : null
}

/** Names an operating system drops into any folder, which a Stoke folder may hold. */
const OS_LITTER = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

/**
 * Whether a top-level name belongs to a Stoke build. The Windows build's top
 * level, measured from `release/win-unpacked` (electron-builder 26.15.3,
 * Electron 43): Stoke.exe, `locales`, `resources`, `.pak`/`.dll`/`.dat`/`.bin`
 * files, `LICENSE.electron.txt`, `LICENSES.chromium.html`,
 * `vk_swiftshader_icd.json`. Shapes rather than a fixed list, so an Electron
 * upgrade that adds a DLL does not make every portable copy "shared".
 */
export function isStokeFolderEntry(name: string): boolean {
  const n = name.toLowerCase()
  if (OS_LITTER.has(n)) return true
  if (n === 'stoke.exe' || n === 'locales' || n === 'resources') return true
  if (/\.(pak|dll|dat|bin)$/.test(n)) return true
  if (/^licen[cs]es?(\.[\w-]+)*\.(txt|html)$/.test(n)) return true
  if (n === 'vk_swiftshader_icd.json') return true
  return false
}

/** The names at the top of a folder that are not part of a Stoke build. */
export function foreignEntries(entries: readonly string[]): string[] {
  return entries.filter((e) => !isStokeFolderEntry(e))
}

function none(kind: InstallKindId): InstallKind {
  return { kind, dir: null, manager: null, command: null, note: null, settled: true }
}

function manual(dir: string | null, note: string, settled = true): InstallKind {
  return { kind: 'manual', dir, manager: null, command: null, note, settled }
}

function managed(manager: 'scoop' | 'winget' | 'chocolatey', command: string, who: string): InstallKind {
  return {
    kind: 'managed',
    dir: null,
    manager,
    command,
    note: `Installed by ${who}, which keeps its own record of what version is here, so Stoke leaves updating to it. Run: ${command}`,
    settled: true
  }
}

/** A winget package folder is `<PackageIdentifier>_<SourceName>_<PublisherHash>`; identifiers may hold `_`. */
export function wingetIdFromFolder(folder: string): string {
  const known = folder.replace(/_Microsoft\.Winget\.Source_8wekyb3d8bbwe$/i, '')
  if (known !== folder && known) return known
  const parts = folder.split('_')
  const id = parts.length >= 3 ? parts.slice(0, -2).join('_') : parts[0]
  return id.includes('.') ? id : 'realvinn.Stoke'
}

function trimRoot(root: string | undefined): string | undefined {
  return root ? root.replace(/[\\/]+$/, '') : undefined
}

/**
 * The classification. Order matters and each step says why it is where it is.
 */
export function classifyInstall(f: InstallFacts): InstallKind {
  if (!f.packaged) return none('source')
  // macOS and Linux have one route each and electron-updater already takes it:
  // Squirrel swaps the .app wherever it is, AppImageUpdater replaces $APPIMAGE.
  if (f.platform !== 'win32') return none('installer')

  const dir = winDirname(f.execPath)
  const dirs = [dir, winDirname(f.execPathRaw ?? f.execPath)]
  const env = f.env

  // 1. electron-builder's single-file `portable` target. It unpacks itself into
  //    %TEMP% on every launch (templates/nsis/portable.nsi) and holds its own exe
  //    open while the app runs, so there is no folder to swap and no file that can
  //    be replaced from inside. Its variable is INHERITED by every child, so it
  //    only counts when this Stoke really runs from the temp folder — a Stoke
  //    started from inside some other portable app must not believe it is one.
  const temps = [env.TEMP, env.TMP].filter((t): t is string => !!t)
  if (env.PORTABLE_EXECUTABLE_FILE && temps.some((t) => dirs.some((d) => winIsUnder(d, t)))) {
    return manual(
      winDirname(env.PORTABLE_EXECUTABLE_FILE),
      `This is a single-file portable build, which cannot replace itself while it runs, so updates have to be downloaded by hand from ${RELEASES_URL}.`
    )
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
  //      Tested against the folder both as started and as resolved.
  const scoopRoots = [env.SCOOP, env.USERPROFILE ? `${trimRoot(env.USERPROFILE)}\\scoop` : undefined, env.SCOOP_GLOBAL, env.ProgramData ? `${trimRoot(env.ProgramData)}\\scoop` : undefined]
  for (const root of scoopRoots.map(trimRoot)) {
    if (!root) continue
    const apps = `${root}\\apps`
    const hit = dirs.find((d) => winIsUnder(d, apps))
    if (hit) return managed('scoop', `scoop update ${segmentBelow(hit, apps) ?? 'stoke'}`, 'Scoop')
  }
  if (env.LOCALAPPDATA) {
    // winget's own portable/zip installs. Stoke's winget package uses the NSIS
    // installer instead, which lands as `installer` below and updates itself;
    // this is for a manifest somebody else writes with InstallerType: zip.
    const packages = `${trimRoot(env.LOCALAPPDATA)}\\Microsoft\\WinGet\\Packages`
    const hit = dirs.find((d) => winIsUnder(d, packages))
    if (hit) return managed('winget', `winget upgrade --id ${wingetIdFromFolder(segmentBelow(hit, packages) ?? '')}`, 'winget')
  }
  const chocoRoots = [env.ChocolateyInstall, env.ProgramData ? `${trimRoot(env.ProgramData)}\\chocolatey` : undefined]
  for (const root of chocoRoots.map(trimRoot)) {
    if (!root) continue
    const lib = `${root}\\lib`
    const hit = dirs.find((d) => winIsUnder(d, lib))
    if (hit) return managed('chocolatey', `choco upgrade ${segmentBelow(hit, lib) ?? 'stoke'}`, 'Chocolatey')
  }

  // 5. The NSIS installer's folder, from the website, the one-liner or winget.
  if (f.hasUninstaller === true) return none('installer')

  // 6. A drive or share root has no folder around Stoke to swap.
  if (isVolumeRoot(dir)) {
    return manual(dir, `Stoke is running from the top of ${dir}, so there is no folder of its own to replace. Move it into a folder of its own to let it update itself, or download updates by hand from ${RELEASES_URL}.`)
  }

  // 7. Anything a probe could not answer: never guess towards the swap.
  if (f.hasUninstaller === null || f.canWriteBeside === null || f.entries === null) {
    return manual(dir, 'Stoke could not yet tell how this copy was installed (the disk was busy), so it will not update itself until the next check can.', false)
  }

  // 8. A folder shared with anything else: the swap would carry it away.
  const foreign = foreignEntries(f.entries)
  if (foreign.length) {
    const shown = foreign.slice(0, 3).join(', ') + (foreign.length > 3 ? `, and ${foreign.length - 3} more` : '')
    return manual(
      dir,
      `Stoke shares its folder, ${dir}, with other things (${shown}). Updating itself would mean replacing that whole folder, so it does not. Move Stoke into a folder of its own to let it update itself, or download updates by hand from ${RELEASES_URL}.`
    )
  }

  // 9. A folder Stoke cannot create files beside. Administrator rights are
  //    named only where they are the likely answer; a read-only stick or share
  //    is not fixed by them (never print a diagnosis the tool can disprove).
  if (f.canWriteBeside === false) {
    const needsAdmin = (f.writeError === 'EACCES' || f.writeError === 'EPERM') && /\\program files( \(x86\))?(\\|$)/i.test(dir)
    const why = needsAdmin ? 'without administrator rights' : f.writeError ? `(${f.writeError})` : ''
    return manual(
      dir,
      `Stoke cannot create files beside ${dir}${why ? ` ${why}` : ''}, which updating itself needs. Move Stoke into a folder you own to let it update itself, or download updates by hand from ${RELEASES_URL}.`
    )
  }

  return {
    kind: 'portable',
    dir,
    manager: null,
    command: null,
    note: `Portable copy in ${dir}. An update is unpacked beside it and swapped in when Stoke restarts or quits; your settings and sessions live elsewhere and are not touched.`,
    settled: true
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
