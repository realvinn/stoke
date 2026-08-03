import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface AudioDevice {
  /** Endpoint id in the form {0.0.1.00000000}.{guid}. */
  id: string
  name: string
  /** True for the endpoint Windows currently hands to apps that ask for "default". */
  isDefault: boolean
}

/*
 * Claude Code's /voice reads the Windows DEFAULT capture endpoint and cannot be
 * pointed at a device - there is no flag, setting key or env var. Routing the
 * phone's microphone into a session therefore means owning that default while
 * the mode is armed, and putting it back afterwards.
 *
 * This is done by shelling out to PowerShell, which compiles COM interop
 * against MMDeviceEnumerator and IPolicyConfig with Add-Type. It needs nothing
 * installed, which is the point: Stoke deliberately avoids native modules so it
 * never needs a rebuild step, and a whole native dependency to set one registry
 * -backed setting would not pay for itself.
 *
 * IPolicyConfig is undocumented. The interface below declares every method that
 * precedes SetDefaultEndpoint so the vtable offsets line up; the placeholders
 * are never called.
 */
const INTEROP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]',
  'class MMDeviceEnumeratorComObject { }',
  '[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'interface IMMDeviceEnumerator {',
  '  int NotImpl1();',
  '  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);',
  '}',
  '[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'interface IMMDevice {',
  '  int Activate(ref Guid iid, int clsCtx, IntPtr p, out IntPtr iface);',
  '  int OpenPropertyStore(int stgm, out IntPtr store);',
  '  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);',
  '  int GetState(out int state);',
  '}',
  '[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]',
  'class CPolicyConfigClient { }',
  '[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'interface IPolicyConfig {',
  '  int GetMixFormat(string n, IntPtr f);',
  '  int GetDeviceFormat(string n, bool d, IntPtr f);',
  '  int ResetDeviceFormat(string n);',
  '  int SetDeviceFormat(string n, IntPtr e, IntPtr m);',
  '  int GetProcessingPeriod(string n, bool d, IntPtr a, IntPtr b);',
  '  int SetProcessingPeriod(string n, IntPtr p);',
  '  int GetShareMode(string n, IntPtr m);',
  '  int SetShareMode(string n, IntPtr m);',
  '  int GetPropertyValue(string n, bool f, IntPtr k, IntPtr v);',
  '  int SetPropertyValue(string n, bool f, IntPtr k, IntPtr v);',
  '  int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);',
  '  int SetEndpointVisibility(string n, bool v);',
  '}',
  'public static class Audio {',
  '  public static string GetDefault(int flow, int role) {',
  '    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());',
  '    IMMDevice dev;',
  '    if (e.GetDefaultAudioEndpoint(flow, role, out dev) != 0) return "";',
  '    string id; dev.GetId(out id); return id;',
  '  }',
  '  public static int SetDefault(string id) {',
  '    var c = (IPolicyConfig)(new CPolicyConfigClient());',
  '    for (int role = 0; role < 3; role++) {',
  '      int hr = c.SetDefaultEndpoint(id, role);',
  '      if (hr != 0) return hr;',
  '    }',
  '    return 0;',
  '  }',
  '}'
].join('\n')

/*
 * PKEY_Device_FriendlyName. The registry stores it under the endpoint's bare
 * guid, in either the Capture or Render subtree. ",14" is the interface name
 * ("VB-Audio Virtual Cable"), which reads well but is not unique across
 * endpoints, so the name proper is ",2".
 */
const NAME_SCRIPT = [
  'function EndpointName($id) {',
  '  if ($id -notmatch \'\\}\\.\\{(.+)\\}$\') { return $null }',
  '  $g = "{" + $Matches[1] + "}"',
  '  foreach ($flow in "Capture","Render") {',
  '    $k = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\$flow\\$g\\Properties"',
  '    if (Test-Path $k) {',
  '      $p = Get-ItemProperty $k',
  '      $n = $p."{a45c254e-df1c-4efd-8020-67d146a850e0},2"',
  '      $i = $p."{b3f8fa53-0004-438e-9003-51a46e139bfc},6"',
  '      if ($n -and $i) { return "$n ($i)" }',
  '      if ($n) { return $n }',
  '    }',
  '  }',
  '  return $null',
  '}'
].join('\n')

/** Endpoint ids are a fixed shape; anything else never reaches PowerShell. */
const ENDPOINT_ID = /^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F-]{36}\}$/

async function powershell(script: string): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
  )
  return stdout
}

/** The capture endpoint Windows hands to anything asking for the default, or null. */
export async function getDefaultCapture(): Promise<AudioDevice | null> {
  const out = await powershell(
    [
      `Add-Type -TypeDefinition @'\n${INTEROP}\n'@ -Language CSharp`,
      NAME_SCRIPT,
      '$id = [Audio]::GetDefault(1, 0)',
      'if (-not $id) { exit 0 }',
      '$n = EndpointName $id',
      'Write-Output ("$id`t$n")'
    ].join('\n')
  )
  const line = out.trim()
  if (!line) return null
  const [id, name] = line.split('\t')
  return { id, name: name || '(unknown)', isDefault: true }
}

/**
 * Active capture endpoints only. Unplugged and disabled devices are excluded
 * because offering one would produce a silent session rather than an error -
 * which is exactly how the current fault presents.
 */
export async function listCaptureDevices(): Promise<AudioDevice[]> {
  const out = await powershell(
    [
      `Add-Type -TypeDefinition @'\n${INTEROP}\n'@ -Language CSharp`,
      NAME_SCRIPT,
      '$def = [Audio]::GetDefault(1, 0)',
      '$root = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture"',
      'Get-ChildItem $root | ForEach-Object {',
      '  $state = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DeviceState',
      '  if ($state -ne 1) { return }',   // 1 = DEVICE_STATE_ACTIVE
      '  $id = "{0.0.1.00000000}." + $_.PSChildName',
      '  $n = EndpointName $id',
      '  if (-not $n) { return }',
      '  Write-Output ("$id`t$n`t" + $(if ($id -eq $def) { "1" } else { "0" }))',
      '}'
    ].join('\n')
  )
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, name, def] = l.split('\t')
      return { id, name: name || '(unknown)', isDefault: def === '1' }
    })
}

/** Point the default capture endpoint at `id` for all three roles. */
export async function setDefaultCapture(id: string): Promise<void> {
  if (!ENDPOINT_ID.test(id)) throw new Error(`refusing to set a malformed endpoint id: ${id}`)
  const out = await powershell(
    [
      `Add-Type -TypeDefinition @'\n${INTEROP}\n'@ -Language CSharp`,
      `$hr = [Audio]::SetDefault('${id}')`,
      'Write-Output $hr'
    ].join('\n')
  )
  const hr = Number(out.trim())
  if (hr !== 0) throw new Error(`SetDefaultEndpoint failed: 0x${(hr >>> 0).toString(16)}`)
}
