import { join } from 'node:path'

/**
 * Read-only kernel snapshot, avoiding Win32_Process's slow WMI provider on
 * Windows ARM64. No process is opened or changed. The native struct's heap
 * pointer follows this PowerShell process's bitness; the buffer is sized by
 * Marshal rather than assuming x64 offsets. API contract:
 * https://learn.microsoft.com/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w
 */
export const WINDOWS_PROCESS_TABLE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class StokeProcessTable {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Entry {
    public uint dwSize, cntUsage, th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
  static extern bool Process32FirstW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
  static extern bool Process32NextW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", ExactSpelling = true)]
  static extern bool CloseHandle(IntPtr handle);
  public static string Read() {
    IntPtr handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Entry entry = new Entry();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(handle, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder result = new StringBuilder();
      do { result.Append(entry.th32ProcessID).Append(' ').Append(entry.th32ParentProcessID).Append('\\n'); }
      while (Process32NextW(handle, ref entry));
      int error = Marshal.GetLastWin32Error();
      if (error != 18) throw new Win32Exception(error);
      return result.ToString();
    } finally { CloseHandle(handle); }
  }
}
'@ -ErrorAction Stop
[Console]::Write([StokeProcessTable]::Read())`

export function windowsProcessTableSpec(): [string, string[]] {
  const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return [command, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT]]
}
