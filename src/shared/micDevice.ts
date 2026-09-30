/**
 * Which microphone Stoke's dictation records from, and whether a device name
 * means "this is not a microphone".
 *
 * Pure and compiled by both projects: main's Windows default-device check
 * (`audio/defaultDevice.ts`) and the renderer's picker and recorder share the
 * one virtual-cable rule, and `verify:voice` runs all of it under node
 * strip-types (gotcha 78). No `navigator` here — the caller enumerates and
 * hands the list in (gotcha 27).
 *
 * Only Stoke's own recorder can be pointed at a device. Claude Code's `/voice`
 * records through its own native module from the system default, and its
 * settings have no device field — so the picker says so rather than implying
 * it moves both.
 */

/**
 * Names that mean "this is not a microphone". Matched against the device's
 * label or the endpoint's friendly name, both of which carry the driver's own
 * branding.
 *
 * Deliberately NOT a bare "Virtual Audio Device": that matched
 * "Headset Microphone (Oculus Virtual Audio Device)", which is a real
 * microphone reached through a virtual driver, and telling a user their working
 * mic is broken is worse than staying quiet. Voicemod is named explicitly since
 * it was the only device that token covered on its own. OBS is word-anchored so
 * it cannot match inside an unrelated name.
 */
const VIRTUAL =
  /VB-?Audio|CABLE Output|Virtual (Audio )?Cable|VoiceMeeter|Voicemod|Line \d \(Virtual|NVIDIA Broadcast|Steam Streaming|Wave Link|\bOBS\b|Streamlabs/i

/**
 * Whether a capture device is a virtual cable rather than a microphone. Moved
 * here from main so a device PICKED in Settings → Voice is judged by the same
 * rule as the Windows default: pick "CABLE Output" and dictation records
 * silence just the same.
 */
export function isVirtualCapture(name: string): boolean {
  return VIRTUAL.test(name)
}

/** The fields of a `MediaDeviceInfo` this module reads. */
export interface MicDevice {
  deviceId: string
  label: string
  kind: string
}

/** What Settings keeps about the chosen microphone (`voice.micDeviceId`/`micLabel`). */
export interface SavedMic {
  id: string | null
  label: string
}

/**
 * Chromium's pseudo-entries: `default` (and on Windows `communications`) are
 * aliases for whichever real device the OS currently has in that role, listed
 * beside the real one under a "Default - " label. The picker's own "System
 * default" row IS that alias, so listing it again would offer the same thing
 * twice under two names — and picking it would pin the alias, not a device.
 */
const PSEUDO_IDS = new Set(['default', 'communications'])

/** The real audio inputs, in the order the browser listed them. */
export function audioInputs(devices: readonly MicDevice[]): MicDevice[] {
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId && !PSEUDO_IDS.has(d.deviceId))
}

/** Whether the browser is withholding device names (it does until a microphone grant). */
export function labelsHidden(devices: readonly MicDevice[]): boolean {
  const inputs = audioInputs(devices)
  return inputs.length > 0 && inputs.every((d) => !d.label)
}

export interface MicPick {
  /** The device to ask getUserMedia for exactly, or null for the system default. */
  deviceId: string | null
  /** Set when the chosen device could not be used, for the strip to say. */
  notice: string | null
}

/**
 * Resolve the saved choice against the devices present now.
 *
 * The exact id wins. A missing id is looked up again by label, because device
 * ids are per-origin and can be re-minted by an OS or driver update while the
 * device itself is right there. Neither found means the device is unplugged:
 * record from the default for now and say so — the setting is left alone, so
 * plugging it back in brings it back without a trip to Settings.
 */
export function pickDevice(devices: readonly MicDevice[], saved: SavedMic | null | undefined): MicPick {
  if (!saved?.id) return { deviceId: null, notice: null }
  const inputs = audioInputs(devices)
  if (inputs.some((d) => d.deviceId === saved.id)) return { deviceId: saved.id, notice: null }
  const label = saved.label.trim()
  if (label) {
    const byLabel = inputs.find((d) => d.label === label)
    if (byLabel) return { deviceId: byLabel.deviceId, notice: null }
  }
  return { deviceId: null, notice: notConnected(label) }
}

/**
 * Whether getUserMedia refused because the asked-for device is not there, as
 * opposed to the permission or a busy device — only this case falls back.
 * Chromium says `OverconstrainedError` for an `exact` id it cannot satisfy and
 * `NotFoundError` when there is no input at all. Read by name, since a
 * DOMException is not an Error in every runtime.
 */
export function isMissingDevice(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

/** The strip's sentence for a chosen device that is not there. */
export function notConnected(label: string): string {
  return `${label || 'The chosen microphone'} is not connected — using the default microphone.`
}

/**
 * The strip's sentence for a microphone that has heard nothing for a while.
 * Names a virtual cable outright, since that is the one cause the label proves.
 */
export function noSignalLine(label: string): string {
  if (label && isVirtualCapture(label)) {
    return `No signal — ${label} is a virtual audio cable, not a microphone. Pick a real one in Settings → Voice.`
  }
  return 'No signal from the microphone — check the device.'
}
