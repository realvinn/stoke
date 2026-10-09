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
$dllFields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'), [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
$errorField = $builder.DefineField('LastError', [int], [Reflection.FieldAttributes]'Public, Static')
$getLastError = [Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error', [Type[]]@())
function Add-NativeMethod([string]$nativeName, [Type]$nativeReturn, [Type[]]$nativeParameters) {
  # DefinePInvokeMethod fixes import metadata before SetCustomAttribute can
  # enable SetLastError. Let DllImport define that metadata in one operation.
  $method = $builder.DefineMethod($nativeName, [Reflection.MethodAttributes]'Public, Static', $nativeReturn, $nativeParameters)
  $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($dllConstructor, [object[]]@('kernel32.dll'), $dllFields, [object[]]@($true, $true, [Runtime.InteropServices.CharSet]::Unicode))
  $method.SetCustomAttribute($attribute)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  # PowerShell's binder may call native code before the next script statement.
  # Capture the saved error in managed IL immediately after the P/Invoke call.
  $checked = $builder.DefineMethod($nativeName + 'Checked', [Reflection.MethodAttributes]'Public, Static', $nativeReturn, $nativeParameters)
  $il = $checked.GetILGenerator()
  $resultLocal = $il.DeclareLocal($nativeReturn)
  for ($at = 0; $at -lt $nativeParameters.Length; $at++) { $il.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]$at) }
  $il.Emit([Reflection.Emit.OpCodes]::Call, $method)
  $il.Emit([Reflection.Emit.OpCodes]::Stloc, $resultLocal)
  $il.Emit([Reflection.Emit.OpCodes]::Call, $getLastError)
  $il.Emit([Reflection.Emit.OpCodes]::Stsfld, $errorField)
  $il.Emit([Reflection.Emit.OpCodes]::Ldloc, $resultLocal)
  $il.Emit([Reflection.Emit.OpCodes]::Ret)
}
Add-NativeMethod 'CreateToolhelp32Snapshot' ([IntPtr]) ([Type[]]@([uint32], [uint32]))
Add-NativeMethod 'Process32FirstW' ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
Add-NativeMethod 'Process32NextW' ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
Add-NativeMethod 'CloseHandle' ([bool]) ([Type[]]@([IntPtr]))
$native = $builder.CreateType()
$snapshot = $native::CreateToolhelp32SnapshotChecked(2, 0)
if ($snapshot -eq [IntPtr](-1)) { throw [ComponentModel.Win32Exception]::new($native::LastError) }
$entry = [IntPtr]::Zero
try {
  # PROCESSENTRY32W: DWORD pid at 8; heap pointer aligns the remaining fields.
  $entrySize = if ([IntPtr]::Size -eq 8) { 568 } else { 556 }
  $parentOffset = if ([IntPtr]::Size -eq 8) { 32 } else { 24 }
  $entry = [Runtime.InteropServices.Marshal]::AllocHGlobal($entrySize)
  [Runtime.InteropServices.Marshal]::WriteInt32($entry, $entrySize)
  if (-not $native::Process32FirstWChecked($snapshot, $entry)) { throw [ComponentModel.Win32Exception]::new($native::LastError) }
  $result = [Text.StringBuilder]::new()
  do {
    $processId = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($entry, 8)
    $parentId = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($entry, $parentOffset)
    [void]$result.Append($processId).Append(' ').Append($parentId).Append([char]10)
  } while ($native::Process32NextWChecked($snapshot, $entry))
  $lastError = $native::LastError
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
