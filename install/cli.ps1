param([ValidateSet('Install','Uninstall')][string]$Action = 'Install', [switch]$NoPath)
$ErrorActionPreference = 'Stop'
$root = if ($env:STOKE_INSTALL_ROOT) { $env:STOKE_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'StokeCli' }
$bin = Join-Path $root 'bin'
$command = Join-Path $bin 'stoke.cmd'
if ($Action -eq 'Uninstall') {
  if ((Test-Path -LiteralPath $command) -and (Get-Content -LiteralPath $command -Raw).Contains('rem Stoke CLI owned launcher')) { Remove-Item -LiteralPath $command }
  $pathMarker = Join-Path $root 'path-owned'
  if (!$NoPath -and (Test-Path -LiteralPath $pathMarker)) {
    $existingPath = [Environment]::GetEnvironmentVariable('Path','User')
    $remaining = ($existingPath -split ';' | Where-Object { $_.TrimEnd([char]92) -ne $bin.TrimEnd([char]92) }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $remaining, 'User')
    Remove-Item -LiteralPath $pathMarker
  }
  Write-Output 'Owned command and PATH entry removed. Installed versions, settings and chats are retained.'
  exit 0
}
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime/node.exe'))) { throw 'Run this installer from an extracted Stoke CLI release.' }
$release = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release.json') -Raw | ConvertFrom-Json
$dest = Join-Path (Join-Path $root 'versions') "$($release.version)-$($release.target)"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
if ((Test-Path -LiteralPath $command) -and !(Get-Content -LiteralPath $command -Raw).Contains('rem Stoke CLI owned launcher')) { throw "Leaving existing $command untouched." }
if (!(Test-Path -LiteralPath $dest)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  $stage = "$dest.$PID.tmp"
  New-Item -ItemType Directory -Path $stage | Out-Null
  Get-ChildItem -LiteralPath $PSScriptRoot -Force | Copy-Item -Destination $stage -Recurse -Force
  Move-Item -LiteralPath $stage -Destination $dest
}
$text = "@echo off`r`nrem Stoke CLI owned launcher`r`nsetlocal DisableDelayedExpansion`r`nset `"PATH=%PATH%;$dest\runtime`"`r`n`"$dest\runtime\node.exe`" `"$dest\lib\stoke.cjs`" %*`r`nexit /b %errorlevel%`r`n"
[System.IO.File]::WriteAllText("$command.tmp", $text, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath "$command.tmp" -Destination $command -Force
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (!$NoPath -and !(($userPath -split ';').TrimEnd([char]92) -contains $bin.TrimEnd([char]92))) {
  [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User')
  [System.IO.File]::WriteAllText((Join-Path $root 'path-owned'), $bin)
}
$env:Path = "$bin;$env:Path"
Write-Output "Installed Stoke CLI $($release.version). Open a new terminal and run stoke."
