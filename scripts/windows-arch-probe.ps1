# What each source a script could ask says this machine's architecture is,
# printed as JSON. Run by .github/workflows/windows.yml from Git Bash, because
# that is the process chain install.sh's handoff uses: Git Bash is an x64
# program emulated on an arm64 PC, and install.ps1 read "x64" there from
# PROCESSOR_ARCHITECTURE and, in a second attempt, from Session Manager's
# registry value too. Not a verify suite; it only reports.
$r = [ordered]@{}
$r.powershell = (Get-Process -Id $PID).Path
$r.is64BitProcess = [Environment]::Is64BitProcess
$r.envProcessorArchitecture = $env:PROCESSOR_ARCHITECTURE
$r.envProcessorArchitew6432 = $env:PROCESSOR_ARCHITEW6432
try {
  $r.registry = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE
} catch { $r.registry = "error: $($_.Exception.Message)" }
try {
  # 0 x86, 5 ARM, 9 x64, 12 ARM64. Answered by the WMI service, a native process.
  $r.cimWin32Processor = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1).Architecture
} catch { $r.cimWin32Processor = "error: $($_.Exception.Message)" }
try {
  Add-Type -Namespace StokeProbe -Name Native -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsWow64Process2(System.IntPtr process, out ushort processMachine, out ushort nativeMachine);'
  $pm = [uint16]0
  $nm = [uint16]0
  [void][StokeProbe.Native]::IsWow64Process2([System.Diagnostics.Process]::GetCurrentProcess().Handle, [ref]$pm, [ref]$nm)
  # 0xAA64 ARM64, 0x8664 x64; a processMachine of 0 means "not WOW64".
  $r.isWow64Process2 = ('process 0x{0:X4}, native 0x{1:X4}' -f $pm, $nm)
} catch { $r.isWow64Process2 = "error: $($_.Exception.Message)" }
try {
  $r.runtimeOSArchitecture = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
} catch { $r.runtimeOSArchitecture = "error: $($_.Exception.Message)" }
$r | ConvertTo-Json
