import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AudioDevice, MicrophoneCheck } from '@shared/api'

const run = promisify(execFile)

/*
 * Why this exists at all.
 *
 * Claude Code's /voice records from the Windows DEFAULT capture endpoint and
 * cannot be pointed at a device - the settings schema is a closed three-key
 * object with no device field. Installing VB-Audio Cable makes its silent
 * virtual cable the system default, so dictation quietly records nothing. That
 * happened on this machine and presented as "voice does not work", with no
 * error anywhere to explain it.
 *
 * Stoke does not set the device: that is a global machine setting it does not
 * own, and Windows Sound settings does it in seconds. Stoke's job is to notice
 * and say so, because nothing else does.
 *
 * Read via PowerShell + Add-Type rather than navigator.mediaDevices, which is
 * the other way to learn the default: enumerateDevices() hides labels until a
 * getUserMedia grant, and prompting for the microphone purely to warn about the
 * microphone is a worse trade than shelling out. Stoke captures no audio on the
 * desktop, so it has no other reason to hold that permission.
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
  'public static class Audio {',
  '  public static string GetDefault(int flow, int role) {',
  '    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());',
  '    IMMDevice dev;',
  '    if (e.GetDefaultAudioEndpoint(flow, role, out dev) != 0) return "";',
  '    string id; dev.GetId(out id); return id;',
  '  }',
  '}'
].join('\n')

/*
 * PKEY_Device_FriendlyName is ",2" under the endpoint's bare guid. ",14" is the
 * interface name ("VB-Audio Virtual Cable"), which reads well but is not unique
 * across endpoints, so it is only used to qualify the name.
 */
const NAME_SCRIPT = [
  'function EndpointName($id) {',
  '  if ($id -notmatch \'\\}\\.\\{(.+)\\}$\') { return $null }',
  '  $g = "{" + $Matches[1] + "}"',
  '  $k = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture\\$g\\Properties"',
  '  if (-not (Test-Path $k)) { return $null }',
  '  $p = Get-ItemProperty $k',
  '  $n = $p."{a45c254e-df1c-4efd-8020-67d146a850e0},2"',
  '  $i = $p."{b3f8fa53-0004-438e-9003-51a46e139bfc},6"',
  '  if ($n -and $i) { return "$n ($i)" }',
  '  return $n',
  '}'
].join('\n')

/**
 * Names that mean "this is not a microphone". Matched against the endpoint's
 * friendly name, which carries the driver's own branding.
 */
const VIRTUAL =
  /VB-?Audio|CABLE Output|Virtual (Audio )?Cable|VoiceMeeter|Line \d \(Virtual|NVIDIA Broadcast|Steam Streaming|Wave Link|OBS|Streamlabs|Virtual Audio Device/i

/**
 * Exported so the matcher can be tested against real device names without
 * changing the machine's default recording device to produce the fault.
 */
export function isVirtualCapture(name: string): boolean {
  return VIRTUAL.test(name)
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
  )
  return stdout
}

function parse(line: string): AudioDevice | null {
  const [id, name] = line.split('\t')
  if (!id || !name) return null
  return { id, name }
}

/**
 * What voice dictation will actually record from, and whether that looks wrong.
 *
 * Never throws: this runs for a warning, and a warning that can break the
 * settings sheet is worse than no warning.
 */
export async function checkMicrophone(): Promise<MicrophoneCheck> {
  const empty: MicrophoneCheck = { device: null, suspect: false, alternatives: [] }
  if (process.platform !== 'win32') return empty

  try {
    const out = await powershell(
      [
        `Add-Type -TypeDefinition @'\n${INTEROP}\n'@ -Language CSharp`,
        NAME_SCRIPT,
        '$def = [Audio]::GetDefault(1, 0)',
        '$n = EndpointName $def',
        'Write-Output ("DEFAULT`t$def`t$n")',
        '$root = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture"',
        'Get-ChildItem $root | ForEach-Object {',
        '  if ((Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DeviceState -ne 1) { return }',
        '  $id = "{0.0.1.00000000}." + $_.PSChildName',
        '  $name = EndpointName $id',
        '  if ($name) { Write-Output ("ACTIVE`t$id`t$name") }',
        '}'
      ].join('\n')
    )

    let device: AudioDevice | null = null
    const active: AudioDevice[] = []
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.startsWith('DEFAULT\t')) device = parse(line.slice('DEFAULT\t'.length))
      else if (line.startsWith('ACTIVE\t')) {
        const d = parse(line.slice('ACTIVE\t'.length))
        if (d) active.push(d)
      }
    }
    if (!device) return empty

    const suspect = isVirtualCapture(device.name)
    return {
      device,
      suspect,
      alternatives: suspect ? active.filter((d) => d.id !== device.id && !isVirtualCapture(d.name)) : []
    }
  } catch {
    // Tell the user nothing rather than something wrong.
    return empty
  }
}
