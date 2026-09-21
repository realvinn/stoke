/*
 * The PowerShell that swaps a portable Stoke's folder for the new one, after
 * Stoke has quit.
 *
 * Why a helper process at all: a Windows directory cannot be renamed while any
 * handle is open beneath it ("A directory cannot be renamed if it or any of its
 * subdirectories contains a file that has open handles" — FILE_RENAME_INFORMATION),
 * and a running Electron app holds dozens: its own exe, every DLL, app.asar,
 * node-pty's `.node` files. Renaming the running exe alone would succeed and
 * leave a folder that is half one version and half the other. So Stoke unpacks
 * the new copy BESIDE the old one — same volume, so each move is a rename,
 * never a copy — writes a plan, starts this detached and quits. This waits for
 * every process running out of the folder to be gone, then renames twice:
 *
 *   <dir>              -> <dir>.old-<from>
 *   <dir>.update-<to>  -> <dir>
 *
 * retrying each (Defender scans freshly unpacked files and holds them for a
 * moment; Electron's crashpad handler outlives the main process), and puts the
 * old folder back if the second rename fails — so the worst outcome is the
 * version you already had, never no Stoke at all. The old folder is NOT deleted
 * here: the new Stoke sweeps it once it has been up long enough to be trusted
 * (selfUpdate.ts), so a release that will not start still leaves a copy that
 * does.
 *
 * "Every process out of the folder", not just Stoke's pid: every running
 * `claude` starts `<execPath> wrapper.mjs` — Stoke.exe itself, in node mode —
 * about three times a second for its statusLine (statusLine.ts), and node-pty
 * forks a console-list agent as Stoke.exe during a kill. Any of those holds the
 * folder open.
 *
 * It NEVER kills anything. Stoke's rule, and the installers': a killed Stoke
 * strands the `claude` processes its sessions run, and the next Stoke cannot
 * reattach to them (CLAUDE.md, "Never force-kill Stoke"). Anything still running
 * after the wait is reported, and the swap is simply not done.
 *
 * HOW IT IS RUN, and each choice is a bug avoided:
 *   - The script is a CONSTANT, ASCII-only file. Windows PowerShell 5.1 reads a
 *     BOM-less script as the ANSI code page, so a non-ASCII byte in it would be
 *     mis-read; nothing variable is ever spliced into it.
 *   - Every path travels in a UTF-8 JSON plan beside it, read with
 *     `Get-Content -Encoding UTF8 | ConvertFrom-Json`. Splicing paths into code
 *     as '…' literals looks safe and is not: PowerShell treats U+2018, U+2019,
 *     U+201A and U+201B as single quotes too (CharTraits.cs), so a profile
 *     folder like `O’Brien` would end the string early.
 *   - `-File`, not `-EncodedCommand`: an encoded command is a stock heuristic
 *     for Defender/ASR, and this runs unattended with nobody to click "allow".
 *     `-ExecutionPolicy Bypass` because the Windows client default, Restricted,
 *     refuses every script file; a Group Policy of AllSigned still wins over it,
 *     which the next launch notices (the staged folder is still there and no
 *     result was written) and says.
 *
 * The outcome is written as JSON to the plan's `resultFile`, which the next
 * launch reads — the only way a failure here can reach a person, since this
 * process has no window. No electron import: verify:portable holds the plan and
 * RUNS this script under a real PowerShell where one exists.
 */

export interface SwapPlan {
  /** Stoke's main process, which has to be gone before anything moves. */
  pid: number
  /** The folder Stoke.exe runs from. */
  appDir: string
  /** The new copy, already unpacked and checked, beside `appDir`. */
  staged: string
  /**
   * The file `stagePortable` writes (in userData) only once `staged` passed
   * every check, naming that folder and version — and deletes before it touches
   * the folder again. The helper requires it rather than just Stoke.exe, which
   * is also there halfway through an unpack (found by review).
   */
  stagedMarker: string
  /**
   * Where the old copy is moved to. If that name is taken the helper appends
   * `-2`, `-3`… — it never deletes an existing folder to make room.
   */
  backup: string
  /** The JSON outcome, read by the next launch. */
  resultFile: string
  /**
   * Written by the helper before it waits (its own pid), so the next launch can
   * tell a helper still waiting from one PowerShell never ran.
   */
  startedFile: string
  /** Versions, for the outcome's wording. */
  from: string
  to: string
  /** Start the new Stoke afterwards ("Restart and install"), or not (install on quit). */
  relaunch: boolean
  /** The exe's file name inside `appDir`. */
  exeName: string
  /** Seconds to wait for Stoke, and everything else running out of `appDir`, to exit. */
  waitSeconds: number
  /** Attempts per rename, half a second apart. */
  renameTries: number
  /**
   * When Stoke wrote this plan and started the helper (epoch ms). The next
   * launch reads it: a plan with no started marker yet is only "PowerShell
   * never ran it" once it is older than a slow start could explain.
   */
  createdAt: number
}

/** The staged-copy marker's contents (see `SwapPlan.stagedMarker`). */
export function stagedMarkerJson(staged: string, version: string): string {
  return JSON.stringify({ dir: staged, version })
}

/**
 * The helper. Constant, so it is the same bytes on every machine and a suite
 * can pin that it stays ASCII.
 */
export const SWAP_SCRIPT = [
  '# Stoke portable update: swap the app folder for the new one after Stoke quits.',
  '# Written and started by Stoke (src/main/portableSwap.ts). Reads its plan from -Plan.',
  'param([Parameter(Mandatory = $true)][string]$Plan)',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$p = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json',
  "$script:lastError = ''",
  '# First, before any wait: say that the helper is running, and as which pid.',
  "try { [System.IO.File]::WriteAllText($p.startedFile, ('{\"pid\":' + $PID + '}'), (New-Object System.Text.UTF8Encoding($false))) } catch { }",
  '',
  '# UTF-8 without a BOM: Windows PowerShell 5.1 writes one with -Encoding utf8,',
  '# and JSON.parse on the other end refuses it.',
  'function Write-Result([bool]$ok, [string]$step, [string]$message) {',
  '  $o = [ordered]@{ ok = $ok; step = $step; message = $message; from = $p.from; to = $p.to; dir = $p.appDir; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }',
  '  try { [System.IO.File]::WriteAllText($p.resultFile, ($o | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))) } catch { }',
  '}',
  '',
  '# A .NET failure arrives wrapped as "Exception calling Move with 2 argument(s)";',
  '# the inner exception is the sentence a person can act on.',
  'function Invoke-Retried([scriptblock]$Action) {',
  '  for ($i = 0; $i -lt [int]$p.renameTries; $i++) {',
  '    try { & $Action; return $true } catch {',
  '      $e = $_.Exception',
  '      if ($e.InnerException) { $e = $e.InnerException }',
  '      $script:lastError = $e.Message',
  '      Start-Sleep -Milliseconds 500',
  '    }',
  '  }',
  '  return $false',
  '}',
  '',
  '# The working directory is the profile, not the app folder: a process whose',
  '# cwd is inside a folder holds it open, and the NEXT update would wait on it.',
  '# Returns why it could not start Stoke, or an empty string. A relaunch that',
  '# fails must not turn a finished swap into a failure: the new copy is in place',
  '# and the next start from the Start menu or a shortcut will run it.',
  'function Start-Stoke([string]$dir) {',
  "  if (-not $p.relaunch) { return '' }",
  '  $exe = Join-Path $dir $p.exeName',
  "  if (-not (Test-Path -LiteralPath $exe)) { return ('There is no ' + $exe + ' to start.') }",
  '  try {',
  '    Start-Process -FilePath $exe -WorkingDirectory ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))',
  "    return ''",
  '  } catch {',
  "    return ('It could not be started again: ' + $_.Exception.Message)",
  '  }',
  '}',
  '',
  '# Everything running out of the folder. Get-CimInstance on Windows rather than',
  '# Get-Process .Path, which a 32-bit PowerShell cannot read for a 64-bit process.',
  '# The Get-Process branch is for PowerShell elsewhere, where CIM does not exist:',
  '# it is how a suite on Linux or macOS exercises this wait at all.',
  '$sep = [System.IO.Path]::DirectorySeparatorChar',
  '$prefix = ([string]$p.appDir).TrimEnd($sep) + $sep',
  'function Get-Inside {',
  '  if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {',
  '    @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {',
  '      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)',
  "    } | ForEach-Object { $_.Name + ' (' + $_.ProcessId + ')' })",
  '  } else {',
  '    @(Get-Process -ErrorAction SilentlyContinue | Where-Object {',
  '      $_.Path -and $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)',
  "    } | ForEach-Object { $_.ProcessName + ' (' + $_.Id + ')' })",
  '  }',
  '}',
  '',
  '# 1. Wait. Never kill.',
  '$deadline = (Get-Date).AddSeconds([int]$p.waitSeconds)',
  'try { Wait-Process -Id ([int]$p.pid) -Timeout ([int]$p.waitSeconds) -ErrorAction SilentlyContinue } catch { }',
  'if (Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue) {',
  "  Write-Result $false 'wait' ('Stoke was still running after ' + $p.waitSeconds + ' seconds, so the update was not applied. It will be offered again.')",
  '  exit 1',
  '}',
  '$left = @(Get-Inside)',
  'while ($left.Count -gt 0 -and (Get-Date) -lt $deadline) {',
  '  Start-Sleep -Milliseconds 500',
  '  $left = @(Get-Inside)',
  '}',
  'if ($left.Count -gt 0) {',
  "  Write-Result $false 'wait' ('Something is still running from ' + $p.appDir + ': ' + ($left -join ', ') + '. The update was not applied; it will be offered again.')",
  '  # Stoke itself is gone and nothing has moved, so "Restart and install" must',
  '  # still restart it: the worst outcome is the version you had, never none.',
  '  [void](Start-Stoke $p.appDir)',
  '  exit 1',
  '}',
  '',
  '# The new copy must be one Stoke finished unpacking AND checked: its marker is',
  '# written only after every check passed, and deleted before the folder is',
  '# touched again. Stoke.exe alone is also there halfway through an unpack.',
  '$ready = $null',
  'try { $ready = Get-Content -LiteralPath $p.stagedMarker -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }',
  'if ((-not $ready) -or ([string]$ready.dir -ne [string]$p.staged) -or ([string]$ready.version -ne [string]$p.to) -or (-not (Test-Path -LiteralPath (Join-Path $p.staged $p.exeName)))) {',
  "  Write-Result $false 'staged' ('The downloaded update at ' + $p.staged + ' is not a complete, checked copy any more, so nothing was changed.')",
  '  [void](Start-Stoke $p.appDir)',
  '  exit 1',
  '}',
  '',
  '# 2. Move the old copy aside, under a name nothing has yet. An existing folder',
  '#    of that name is NEVER deleted to make room: it may be a copy the sweep',
  '#    refused to delete because it holds something that is not Stoke.',
  '$backup = [string]$p.backup',
  "for ($n = 2; Test-Path -LiteralPath $backup; $n++) { $backup = [string]$p.backup + '-' + $n }",
  'if (-not (Invoke-Retried { [System.IO.Directory]::Move($p.appDir, $backup) })) {',
  "  Write-Result $false 'move-old' ('Could not move ' + $p.appDir + ' aside: ' + $script:lastError + ' Nothing was changed.')",
  '  [void](Start-Stoke $p.appDir)',
  '  exit 1',
  '}',
  '',
  '# 3. Move the new copy in. If that fails, put the old one back.',
  'if (-not (Invoke-Retried { [System.IO.Directory]::Move($p.staged, $p.appDir) })) {',
  '  $why = $script:lastError',
  '  if (Invoke-Retried { [System.IO.Directory]::Move($backup, $p.appDir) }) {',
  "    Write-Result $false 'move-new' ('Could not move the new version into place: ' + $why + ' The old version was put back.')",
  '    [void](Start-Stoke $p.appDir)',
  '  } else {',
  "    Write-Result $false 'rollback' ('Could not move the new version into place (' + $why + '), nor put the old one back (' + $script:lastError + '). The old version is at ' + $backup + ' and the new one at ' + $p.staged + '.')",
  '  }',
  '  exit 1',
  '}',
  '',
  '# 4. Done. The old folder stays until the new Stoke has proved it starts.',
  '$launch = Start-Stoke $p.appDir',
  "Write-Result $true 'done' $launch",
  'exit 0',
  ''
].join('\r\n')

/** The plan file's contents: JSON, UTF-8, nothing else. */
export function planJson(p: SwapPlan): string {
  return JSON.stringify(p, null, 2)
}

/**
 * The argv for `powershell.exe`. `-NonInteractive` so nothing can ever wait on
 * a prompt nobody can see; `-WindowStyle Hidden` alongside the spawn's
 * `windowsHide`, so no console flashes up over the desktop.
 */
export function swapArgs(scriptPath: string, planPath: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-Plan', planPath]
}

function trimSep(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

/** Where the old copy goes, beside the app folder: `<dir>.old-<from>`. */
export function backupDirFor(appDir: string, from: string): string {
  return `${trimSep(appDir)}.old-${from}`
}

/** Where a new version is unpacked, beside the app folder: `<dir>.update-<to>`. */
export function stagedDirFor(appDir: string, to: string): string {
  return `${trimSep(appDir)}.update-${to}`
}

/**
 * Which siblings of the app folder are leftovers this machinery made:
 * `<name>.old-<version>` and `<name>.update-<version>`, plus the helper's
 * `<name>.old-<version>-<n>` when the first backup name was taken (the `-n`
 * reads as a prerelease tag, which the pattern already allows). Anything else
 * beside the folder — the user's own files — is never matched, whatever it is
 * called.
 */
export function isLeftover(appDirName: string, sibling: string): 'old' | 'update' | null {
  const esc = appDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^${esc}\\.(old|update)-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`, 'i').exec(sibling)
  return m ? (m[1].toLowerCase() as 'old' | 'update') : null
}
