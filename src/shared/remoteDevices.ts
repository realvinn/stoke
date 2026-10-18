/* The phone website's view of this computer's approved Stoke Hub devices.
 * Identity keys and hub credentials stay in main; terminal traffic uses the
 * existing per-session encrypted relay and its host's approval. */
import type { OtherMachineView, RemoteSessionStatus, RemoteTabState } from './hub/remote.ts'
import type { RelayMode } from './hub/relay.ts'

export interface RemoteDevicesResponse {
  available: boolean
  machines: OtherMachineView[]
}

/** Sent on /ws/machine before the host's ordinary phone terminal frames. */
export interface RemoteDeviceState {
  type: 'remote-state'
  state: RemoteTabState
  message: string | null
  mode: RelayMode | null
  sizes: boolean
  typeOnly: boolean
  deviceLabel: string
  title: string
  project: string
  session: RemoteSessionStatus | null
}

/** Limits apply before data enters a relay; typing is never queued offline. */
export const REMOTE_DEVICE_INPUT_MAX = 64 * 1024
export const REMOTE_DEVICE_SUBMIT_MAX = 20_000
