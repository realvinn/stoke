import { execFile } from 'node:child_process'
import { WINDOWS_PROCESS_TABLE_SCRIPT, windowsProcessTableSpec } from './windowsProcessTable.ts'

export const ACCOUNT_IDENTITY_CLEANUP_TIMEOUT_MS = 12_000
export interface WindowsIdentityCleanupOptions {
  /** Suite seams; production always uses the fixed native helper and limits. */
  powershell?: string
  timeoutMs?: number
  captureDelayMs?: number
  pauseAfterOwnershipMs?: number
  timeoutAfterOwnershipMs?: number
}
export interface WindowsIdentityCleanupResult { cleaned: boolean; failed: boolean }

/** Native handles pin identity; a fresh Toolhelp snapshot proves parent edges.
 * The unnamed kill-on-close job contains descendants born during cleanup and
 * survives neither helper failure nor its deadline. No PID-based killer runs.
 * Windows 8+ permits the nested jobs used by CI. API contracts:
 * https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
 * https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
 * https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
 * https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
 * Variable data stays in environment values; output is numeric metadata only.
 */
const CLEANUP_STAGES = ['initializing', 'system-directory', 'root-parent', 'root-open', 'root-created', 'job-create', 'job-limit', 'capture', 'root-ancestry', 'image-query', 'job-query', 'job-assign', 'job-stop', 'process-wait', 'job-accounting', 'done']
export const WINDOWS_IDENTITY_CLEANUP_SCRIPT = "[Console]::WriteLine('{\"phase\":\"stage\",\"stage\":\"initializing\",\"targetPid\":0,\"targetDepth\":0}'); [Console]::Out.Flush()\n" + WINDOWS_PROCESS_TABLE_SCRIPT
  .replace('$native = $builder.CreateType()', `Add-NativeMethod 'OpenProcess' ([IntPtr]) ([Type[]]@([uint32], [bool], [uint32]))
Add-NativeMethod 'GetProcessTimes' ([bool]) ([Type[]]@([IntPtr], [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType()))
Add-NativeMethod 'GetSystemDirectoryW' ([uint32]) ([Type[]]@([IntPtr], [uint32]))
Add-NativeMethod 'QueryFullProcessImageNameW' ([bool]) ([Type[]]@([IntPtr], [uint32], [IntPtr], [uint32].MakeByRefType()))
Add-NativeMethod 'WaitForSingleObject' ([uint32]) ([Type[]]@([IntPtr], [uint32]))
Add-NativeMethod 'CreateJobObjectW' ([IntPtr]) ([Type[]]@([IntPtr], [string]))
Add-NativeMethod 'SetInformationJobObject' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32]))
Add-NativeMethod 'QueryInformationJobObject' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32], [IntPtr]))
Add-NativeMethod 'AssignProcessToJobObject' ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
Add-NativeMethod 'IsProcessInJob' ([bool]) ([Type[]]@([IntPtr], [IntPtr], [bool].MakeByRefType()))
Add-NativeMethod 'TerminateJobObject' ([bool]) ([Type[]]@([IntPtr], [uint32]))
$native = $builder.CreateType()`)
  .replace('[Console]::Write($result.ToString())', '$rows = $result.ToString()') + '\nfunction Read-CurrentParents {\n' + WINDOWS_PROCESS_TABLE_SCRIPT.slice(WINDOWS_PROCESS_TABLE_SCRIPT.indexOf('$snapshot = $native::')).replace('[Console]::Write($result.ToString())', 'return $result.ToString()') + '\n}\n' + `
$rootId = [uint32]::Parse($env:STOKE_IDENTITY_ROOT_PID)
$ownerId = [uint32]::Parse($env:STOKE_IDENTITY_OWNER_PID)
$earliest = [long]116444736000000000 + ([long]::Parse($env:STOKE_IDENTITY_SPAWN_FROM) - 1) * 10000
$latest = [long]116444736000000000 + ([long]::Parse($env:STOKE_IDENTITY_SPAWN_UNTIL) + 1) * 10000
$parents = @{}
foreach ($row in $rows.Split([char]10)) {
  if ($row -match '^(\\d+) (\\d+)$') { $parents[[uint32]::Parse($Matches[1])] = [uint32]::Parse($Matches[2]) }
}
$held = @{}
$job = [IntPtr]::Zero
$info = [IntPtr]::Zero
$captured = 0
$remaining = -1
$nativeError = 0
$stage = 'system-directory'
$targetPid = $rootId
$targetDepth = 0
$facilities = 0
$pathBuffer = [IntPtr]::Zero
$systemDirectory = ''
$clock = [Diagnostics.Stopwatch]::StartNew()
function Open-OwnedProcess([uint32]$processId, [int]$depth, [long]$parentCreated) {
  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION | SET_QUOTA | TERMINATE.
  $handle = $native::OpenProcessChecked(0x00101101, $false, $processId)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $created = [long]0; $exited = [long]0; $kernel = [long]0; $user = [long]0
  if (-not $native::GetProcessTimesChecked($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user) -or $created -lt $parentCreated) {
    [void]$native::CloseHandle($handle); return $null
  }
  return @{ Id = $processId; Handle = $handle; Created = $created; Depth = $depth; Facility = $false }
}
function Is-ConsoleFacility([IntPtr]$handle) {
  $characters = [uint32]32768
  if (-not $native::QueryFullProcessImageNameWChecked($handle, 0, $pathBuffer, [ref]$characters)) { return $false }
  $image = [Runtime.InteropServices.Marshal]::PtrToStringUni($pathBuffer, $characters)
  # These are OS console servers, not child programs owned by an agent.
  # Their exact directory comes from the OS, not PATH or SystemRoot. A
  # vendor or fixture executable with either basename remains fully owned.
  return [string]::Equals($image, [IO.Path]::Combine($systemDirectory, 'conhost.exe'), [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($image, [IO.Path]::Combine($systemDirectory, 'openconsole.exe'), [StringComparison]::OrdinalIgnoreCase)
}
try {
  $pathBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(65536)
  $characters = $native::GetSystemDirectoryWChecked($pathBuffer, 32768)
  if ($characters -eq 0 -or $characters -ge 32768) { $nativeError = $native::LastError; throw 'system-directory-unavailable' }
  $systemDirectory = [Runtime.InteropServices.Marshal]::PtrToStringUni($pathBuffer, $characters)
  $stage = 'root-parent'
  if ($rootId -eq $ownerId -or $rootId -eq $PID -or $parents[$rootId] -ne $ownerId) { throw 'unowned-root' }
  $stage = 'root-open'
  $rootProcess = Open-OwnedProcess $rootId 0 $earliest
  if ($null -eq $rootProcess) { throw 'root-unavailable' }
  $held[$rootId] = $rootProcess
  $stage = 'root-created'
  if ($rootProcess.Created -gt $latest) { throw 'root-replaced' }
  $stage = 'job-create'
  $job = $native::CreateJobObjectWChecked([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { $nativeError = $native::LastError; throw 'job-unavailable' }
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: flags at 16, size 144/112.
  $infoSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal($infoSize)
  for ($at = 0; $at -lt $infoSize; $at += 4) { [Runtime.InteropServices.Marshal]::WriteInt32($info, $at, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($info, 16, 0x2000)
  $stage = 'job-limit'
  if (-not $native::SetInformationJobObjectChecked($job, 9, $info, $infoSize)) { $nativeError = $native::LastError; throw 'job-limit-failed' }
  $delay = [int]::Parse($env:STOKE_IDENTITY_CAPTURE_DELAY)
  do {
    $stage = 'capture'
    [Console]::WriteLine((@{ phase = 'stage'; stage = $stage; targetPid = $targetPid; targetDepth = $targetDepth } | ConvertTo-Json -Compress)); [Console]::Out.Flush()
    do {
      $added = $false
      foreach ($processId in @($parents.Keys)) {
        if ($held.ContainsKey($processId) -or $processId -eq $ownerId -or $processId -eq $PID) { continue }
        $parent = $held[$parents[$processId]]
        if ($null -eq $parent -or $parent.Facility) { continue }
        $owned = Open-OwnedProcess $processId ($parent.Depth + 1) $parent.Created
        if ($null -ne $owned) { $held[$processId] = $owned; $added = $true }
      }
    } while ($added)
    # A PID can be reused between snapshot and OpenProcess. Confirm ancestry
    # after handles are pinned, before assigning anything to the kill job.
    $currentParents = @{}
    foreach ($row in (Read-CurrentParents).Split([char]10)) {
      if ($row -match '^(\\d+) (\\d+)$') { $currentParents[[uint32]::Parse($Matches[1])] = [uint32]::Parse($Matches[2]) }
    }
    $stage = 'root-ancestry'; $targetPid = $rootId; $targetDepth = 0
    if ($currentParents.ContainsKey($rootId)) {
      if ($currentParents[$rootId] -ne $ownerId) { throw 'root-ancestry-changed' }
    } elseif ($native::WaitForSingleObject($rootProcess.Handle, 0) -ne 0) { throw 'root-ancestry-changed' }
    foreach ($owned in @($held.Values | Sort-Object -Property Depth)) {
      $targetPid = $owned.Id; $targetDepth = $owned.Depth
      if ($owned.Id -ne $rootId) {
        $originalParent = $parents[$owned.Id]
        if ($currentParents.ContainsKey($owned.Id) -and $currentParents[$owned.Id] -ne $originalParent -or -not $held.ContainsKey($originalParent)) {
          [void]$native::CloseHandle($owned.Handle); $held.Remove($owned.Id); continue
        }
        if ($held[$originalParent].Facility) { $owned.Facility = $true; continue }
      }
      $stage = 'image-query'
      if ($owned.Depth -gt 0 -and (Is-ConsoleFacility $owned.Handle)) {
        if (-not $owned.Facility) { $facilities++ }
        $owned.Facility = $true
        continue
      }
      if ($native::WaitForSingleObject($owned.Handle, 0) -eq 0) { continue }
      $inside = $false
      $stage = 'job-query'
      if (-not $native::IsProcessInJobChecked($owned.Handle, $job, [ref]$inside)) { $nativeError = $native::LastError; throw 'job-query-failed' }
      $stage = 'job-assign'
      if (-not $inside -and -not $native::AssignProcessToJobObjectChecked($job, $owned.Handle)) { $nativeError = $native::LastError; throw 'job-assignment-failed' }
    }
    # Only the suite pauses capture. Future children of assigned parents
    # inherit this job; pre-assignment children are captured by the next pass.
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay; $delay = 0 }
    $parents = @{}
    foreach ($row in (Read-CurrentParents).Split([char]10)) {
      if ($row -match '^(\\d+) (\\d+)$') { $parents[[uint32]::Parse($Matches[1])] = [uint32]::Parse($Matches[2]) }
    }
    $missing = $false
    foreach ($processId in $parents.Keys) {
      if (-not $held.ContainsKey($processId) -and $held.ContainsKey($parents[$processId]) -and -not $held[$parents[$processId]].Facility) { $missing = $true; break }
    }
    if ($clock.ElapsedMilliseconds -gt 6000) { throw 'capture-deadline' }
  } while ($missing)
  $captured = $held.Count
  $stage = 'job-stop'; $targetPid = $rootId; $targetDepth = 0
  # This checkpoint follows capture of all owned program descendants;
  # trusted OS console facility subtrees remain outside this ownership.
  # Future program descendants inherit the job. If the helper exits or dies,
  # the sole non-inherited job handle closes and terminates the entire job.
  [Console]::WriteLine((@{ phase = 'owned'; captured = $captured } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $pause = [int]::Parse($env:STOKE_IDENTITY_POST_OWNERSHIP_PAUSE)
  if ($pause -gt 0) { Start-Sleep -Milliseconds $pause }
  if (-not $native::TerminateJobObjectChecked($job, 1)) { $nativeError = $native::LastError; throw 'job-termination-failed' }
  $stage = 'process-wait'
  $wait = [Diagnostics.Stopwatch]::StartNew()
  foreach ($owned in $held.Values) {
    if ($owned.Facility) { continue }
    $targetPid = $owned.Id; $targetDepth = $owned.Depth
    $waitMs = [uint32][Math]::Max(0, 2000 - $wait.ElapsedMilliseconds)
    if ($native::WaitForSingleObject($owned.Handle, $waitMs) -ne 0) { throw 'process-wait-deadline' }
  }
  foreach ($owned in $held.Values) { [void]$native::CloseHandle($owned.Handle) }
  $held.Clear()
  $stage = 'job-accounting'; $targetPid = $rootId; $targetDepth = 0
  # Accounting also includes descendants born after the last snapshot.
  do {
    if (-not $native::QueryInformationJobObjectChecked($job, 1, $info, 48, [IntPtr]::Zero)) { $nativeError = $native::LastError; throw 'job-accounting-failed' }
    $remaining = [Runtime.InteropServices.Marshal]::ReadInt32($info, 40)
    if ($remaining -ne 0 -and $wait.ElapsedMilliseconds -lt 2000) { Start-Sleep -Milliseconds 10 }
  } while ($remaining -ne 0 -and $wait.ElapsedMilliseconds -lt 2000)
  if ($remaining -eq 0) { $stage = 'done' }
} catch {
  # Exception text may contain local data; emit fixed numeric metadata only.
  $captured = [Math]::Max($captured, $held.Count)
  $remaining = -1
} finally {
  if ($job -ne [IntPtr]::Zero) { [void]$native::CloseHandle($job) }
  foreach ($owned in $held.Values) { [void]$native::CloseHandle($owned.Handle) }
  if ($info -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
  if ($pathBuffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($pathBuffer) }
}
[Console]::Write((@{ phase = 'done'; stage = $stage; targetPid = $targetPid; targetDepth = $targetDepth; facilities = $facilities; captured = $captured; remaining = $remaining; nativeError = $nativeError } | ConvertTo-Json -Compress))
`

export function stopWindowsAccountIdentity(pid: number, spawnedFrom: number, spawnedUntil: number, options: WindowsIdentityCleanupOptions = {}): Promise<WindowsIdentityCleanupResult> {
  const [command] = windowsProcessTableSpec()
  const started = Date.now()
  return new Promise(resolve => {
    let afterOwnershipTimer: ReturnType<typeof setTimeout> | undefined
    const helper = execFile(options.powershell ?? command, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDENTITY_CLEANUP_SCRIPT], {
      timeout: options.timeoutMs ?? ACCOUNT_IDENTITY_CLEANUP_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true,
      env: { ...process.env, STOKE_IDENTITY_ROOT_PID: String(pid), STOKE_IDENTITY_OWNER_PID: String(process.pid), STOKE_IDENTITY_SPAWN_FROM: String(spawnedFrom), STOKE_IDENTITY_SPAWN_UNTIL: String(spawnedUntil), STOKE_IDENTITY_CAPTURE_DELAY: String(Math.max(0, Math.min(2000, options.captureDelayMs ?? 0))), STOKE_IDENTITY_POST_OWNERSHIP_PAUSE: String(Math.max(0, Math.min(3000, options.pauseAfterOwnershipMs ?? 0))) }
    }, (error, stdout) => {
      clearTimeout(afterOwnershipTimer)
      const metadata: Record<string, string | number | boolean | null> = { pid, elapsedMs: Date.now() - started }
      const reports: Array<Record<string, unknown>> = []
      for (const line of String(stdout).trim().split('\n')) {
        try { const parsed = JSON.parse(line); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reports.push(parsed) }
        catch { /* fixed helper output only */ }
      }
      const owned = reports.some(report => report.phase === 'owned' && Number.isInteger(report.captured) && (report.captured as number) > 0)
      const lastStage = reports.filter(report => CLEANUP_STAGES.includes(String(report.stage)) && Number.isInteger(report.targetPid) && Number.isInteger(report.targetDepth)).at(-1)
      if (lastStage) { metadata.stage = String(lastStage.stage); metadata.targetPid = lastStage.targetPid as number; metadata.targetDepth = lastStage.targetDepth as number }
      if (error) {
        metadata.code = error.code ?? null; metadata.killed = !!error.killed; metadata.signal = error.signal ?? null; metadata.jobOwned = owned
        console.warn('[stoke] account identity tree cleanup failed', metadata)
        // execFile's callback follows helper close. Its sole job handle has
        // closed, which Windows guarantees kills every associated process.
        // The caller still waits for its native child close before retiring.
        resolve({ cleaned: owned, failed: true }); return
      }
      try {
        const report = reports.find(report => report.phase === 'done')
        if (!report) throw new Error('no cleanup outcome')
        for (const name of ['captured', 'remaining', 'nativeError', 'facilities']) if (!Number.isInteger(report[name])) throw new Error('invalid cleanup count')
        if (report.remaining !== 0 || report.facilities) console.warn('[stoke] account identity tree cleanup', { ...metadata, captured: report.captured, remaining: report.remaining, nativeError: report.nativeError, facilities: report.facilities, jobOwned: owned })
        resolve({ cleaned: report.remaining === 0 || owned, failed: report.remaining !== 0 })
      } catch { console.warn('[stoke] account identity tree cleanup returned no valid outcome', { ...metadata, jobOwned: owned }); resolve({ cleaned: owned, failed: true }) }
    })
    if (options.timeoutAfterOwnershipMs !== undefined) {
      let buffer = ''
      helper.stdout?.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk)
        let end: number
        while (!afterOwnershipTimer && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const report = JSON.parse(line)
            if (report?.phase === 'owned') afterOwnershipTimer = setTimeout(() => helper.kill('SIGKILL'), options.timeoutAfterOwnershipMs)
          } catch { /* the normal bounded helper deadline still applies */ }
        }
      })
    }
  })
}
