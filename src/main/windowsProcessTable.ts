import { join } from 'node:path'

/**
 * Read-only kernel snapshot, avoiding Win32_Process's slow WMI provider on
 * Windows ARM64. No process is opened or changed. Emit the four P/Invoke
 * declarations in memory: Add-Type starts a C# compiler that exceeds our
 * five-second deadline on ARM64. The buffer follows the reader's bitness.
 * API contracts:
 * https://learn.microsoft.com/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w
 * https://learn.microsoft.com/dotnet/api/system.reflection.emit.typebuilder.definepinvokemethod
 */
export const WINDOWS_PROCESS_TABLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$assemblyName = [Reflection.AssemblyName]::new('StokeProcessTable')
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('StokeProcessTable')
$builder = $module.DefineType('StokeProcessTable', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
$dllConstructor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
$dllFields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'))
function Add-NativeMethod([string]$nativeName, [Type]$nativeReturn, [Type[]]$nativeParameters) {
  $method = $builder.DefinePInvokeMethod($nativeName, 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $nativeReturn, $nativeParameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($dllConstructor, [object[]]@('kernel32.dll'), $dllFields, [object[]]@($true, $true))
  $method.SetCustomAttribute($attribute)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Add-NativeMethod 'CreateToolhelp32Snapshot' ([IntPtr]) ([Type[]]@([uint32], [uint32]))
Add-NativeMethod 'Process32FirstW' ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
Add-NativeMethod 'Process32NextW' ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
Add-NativeMethod 'CloseHandle' ([bool]) ([Type[]]@([IntPtr]))
$native = $builder.CreateType()
$snapshot = $native::CreateToolhelp32Snapshot(2, 0)
if ($snapshot -eq [IntPtr](-1)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$entry = [IntPtr]::Zero
try {
  # PROCESSENTRY32W: DWORD pid at 8; heap pointer aligns the remaining fields.
  $entrySize = if ([IntPtr]::Size -eq 8) { 568 } else { 556 }
  $parentOffset = if ([IntPtr]::Size -eq 8) { 32 } else { 24 }
  $entry = [Runtime.InteropServices.Marshal]::AllocHGlobal($entrySize)
  [Runtime.InteropServices.Marshal]::WriteInt32($entry, $entrySize)
  if (-not $native::Process32FirstW($snapshot, $entry)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $result = [Text.StringBuilder]::new()
  do {
    $processId = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($entry, 8)
    $parentId = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($entry, $parentOffset)
    [void]$result.Append($processId).Append(' ').Append($parentId).Append([char]10)
  } while ($native::Process32NextW($snapshot, $entry))
  $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($lastError -ne 18) { throw [ComponentModel.Win32Exception]::new($lastError) }
  [Console]::Write($result.ToString())
} finally {
  if ($entry -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($entry) }
  [void]$native::CloseHandle($snapshot)
}`

export function windowsProcessTableSpec(): [string, string[]] {
  const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return [command, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT]]
}
