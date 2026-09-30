/*
 * Domain separation for every signature, KDF and AAD in Stoke Hub.
 *
 * Each signed text, HKDF `info` and GCM additional-data string is one label
 * from HUB_LABELS, a newline, and the canonical JSON of its fields
 * (`labelled`). Two reasons it is all in one table:
 *
 * - A label is what keeps a signature made for one purpose from being
 *   accepted for another (a chain entry's signature is not a relay
 *   handshake's), so no two may ever be equal — verify:hub asserts it.
 * - A label is also part of every key and ciphertext already stored on a hub.
 *   Changing one makes every wrap and item sealed under it unreadable, which
 *   is why verify:hub pins test vectors over all of them: a changed string
 *   fails the suite until it is a deliberate `v2`.
 *
 * Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §4.
 */
import { labelled } from './codec.ts'

export const HUB_LABELS = {
  /** A device's signature over one HTTP request (protocol.ts `requestSigningText`). */
  request: 'stoke-hub/v1/request',
  /** A device's (or the recovery key's) signature over one chain entry. */
  chain: 'stoke-hub/v1/chain',
  /** The hash that links a chain entry to the next (`prev`). */
  chainLink: 'stoke-hub/v1/chain-link',
  /** The new device's commitment when it asks to pair. */
  pairCommit: 'stoke-hub/v1/pair-commit',
  /** What both screens' six digits are cut from. */
  pairSas: 'stoke-hub/v1/pair-sas',
  /** HKDF info and GCM AAD for the vault key wrapped to one device. */
  vkWrap: 'stoke-hub/v1/vk-wrap',
  /** HKDF info for the commitment to one epoch's vault key that the chain entry opening the epoch signs. */
  vkCommit: 'stoke-hub/v1/vk-commit',
  /** HKDF info (salt: account) for the Recovery Kit's wrapping key, and the wrap's AAD. */
  recoveryWrap: 'stoke-hub/v1/recovery-wrap',
  /** HKDF info (salt: account) for the Recovery Kit's Ed25519 seed. */
  recoverySign: 'stoke-hub/v1/recovery-sign',
  /** HKDF info for the AES-256-GCM key items of one epoch are sealed with. */
  itemKey: 'stoke-hub/v1/item-key',
  /** HKDF info for the HMAC key an item's opaque id is derived with. */
  itemId: 'stoke-hub/v1/item-id',
  /** GCM AAD of one item. */
  item: 'stoke-hub/v1/item',
  /** The relay handshake's transcript hash. */
  relayTranscript: 'stoke-hub/v1/relay-hs',
  /** The host's signature in `hs2`. */
  relayHs2: 'stoke-hub/v1/relay-hs2',
  /** The guest's signature in `hs3`. */
  relayHs3: 'stoke-hub/v1/relay-hs3',
  /** HKDF info for the relay's two direction keys. */
  relayKeys: 'stoke-hub/v1/relay-keys',
  /** GCM AAD of one relay frame. */
  relayFrame: 'stoke-hub/v1/relay-frame'
} as const

export type HubLabel = (typeof HUB_LABELS)[keyof typeof HUB_LABELS]

/* ---------------------------------------------------------- vault keys */

/** HKDF info AND GCM AAD for `VK_epoch` wrapped to `device`'s X25519 key. */
export function vkWrapInfo(f: { account: string; epoch: number; device: string }): string {
  return labelled(HUB_LABELS.vkWrap, { account: f.account, epoch: f.epoch, device: f.device })
}

/**
 * HKDF info for `ChainEntry.vk`, the commitment to `VK_epoch` (crypto.ts
 * `vaultKeyCommit`). A wrap is an anonymous box anyone holding a device's
 * PUBLIC key can make, of any key they choose; this commitment, signed into
 * the chain the hub cannot extend, is what says which key an epoch's is.
 */
export function vkCommitInfo(f: { account: string; epoch: number }): string {
  return labelled(HUB_LABELS.vkCommit, { account: f.account, epoch: f.epoch })
}

/** GCM AAD for `VK_epoch` wrapped by the Recovery Kit's key. */
export function recoveryWrapAad(f: { account: string; epoch: number }): string {
  return labelled(HUB_LABELS.recoveryWrap, { account: f.account, epoch: f.epoch })
}

/** HKDF info for this epoch's item-sealing key. */
export function itemKeyInfo(f: { account: string; epoch: number }): string {
  return labelled(HUB_LABELS.itemKey, { account: f.account, epoch: f.epoch })
}

/** HKDF info for this epoch's item-id HMAC key. */
export function itemIdInfo(f: { account: string; epoch: number }): string {
  return labelled(HUB_LABELS.itemId, { account: f.account, epoch: f.epoch })
}
