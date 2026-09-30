/*
 * One end of an end-to-end encrypted relay between two of the owner's devices
 * (spec §6.3, §6.4): the SIGMA-style handshake, then AES-256-GCM frames with
 * a counter per direction. The hub forwards every byte of it and can read
 * none: the keys come from ephemeral X25519 keys signed by device keys that
 * THIS device's verified chain holds — never from anything the relay says.
 *
 * Transport-agnostic on purpose (`ChannelIO`): the desktop drives it over a
 * `ws` socket to the hub, and `verify:hub-relay` drives two of them against
 * each other in memory, with a relay in the middle that drops, repeats,
 * reorders and rewrites frames.
 *
 * What it refuses, each a closed channel and never a skipped frame:
 * - a peer key the chain does not hold as active, or a signature by any other
 *   key (a hub that swaps an ephemeral key, or plays the other device);
 * - a handshake for another relay, account, host, or a guest other than the
 *   one the hub named;
 * - after the handshake: text frames, a frame that does not open under the
 *   next counter (dropped, repeated, reordered, edited, reflected, or from
 *   another relay), and anything that is not a well-formed inner frame.
 *
 * Imports only `crypto.ts` and src/shared by relative path, no electron
 * (gotcha 78). No TypeScript parameter properties (strip-only mode).
 */
import { fromUtf8, utf8 } from '../../shared/hub/codec.ts'
import {
  hs1Problem,
  parseRelayInner,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_MESSAGE_CHARS,
  relayFrameParts,
  type RelayHs1,
  type RelayHs2,
  type RelayHs3,
  type RelayInnerFrame
} from '../../shared/hub/relay.ts'
import { RelayCipher, relayAccept, relayAnswer, relayEphemeral, relayFinish, relayHello, relayKeys, type RelayEphemeral } from './crypto.ts'

export interface ChannelIO {
  /** Put one frame on the relay socket: text during the handshake, bytes after. */
  send(data: string | Uint8Array): void
  /** Close the relay socket. */
  close(code: number, reason: string): void
}

export interface ChannelEvents {
  /** The handshake verified both ends: frames may flow. */
  onOpen(): void
  /** One inner frame, `part`s already joined. */
  onFrame(frame: RelayInnerFrame): void
  /** Closed, by either end, the relay, or a refusal here. Called once. */
  onClose(reason: string): void
}

export interface RelayChannelOptions {
  role: 'guest' | 'host'
  relay: string
  account: string
  me: { id: string; signPriv: string }
  /** The other end: for a guest, the host it asked for; for a host, the guest the hub named in its `relay` frame. */
  peer: string
  /**
   * The peer's signing key as THIS device's verified chain holds it for an
   * ACTIVE device (by id and key, gotcha 140), or null to refuse it.
   */
  peerKey: (id: string) => string | null
  io: ChannelIO
  events: ChannelEvents
  /** Tests only: a fixed ephemeral seed and handshake nonce. */
  fixed?: { eph?: Uint8Array; nonce?: Uint8Array }
}

export type ChannelState = 'idle' | 'handshake' | 'open' | 'closed'

export class RelayChannel {
  private readonly o: RelayChannelOptions
  private readonly eph: RelayEphemeral
  private st: ChannelState
  private hs1: RelayHs1 | null
  private hs2: RelayHs2 | null
  private th: string
  private peerSign: string | null
  private sendCipher: RelayCipher | null
  private recvCipher: RelayCipher | null
  private parts: string[]
  private partChars: number
  /** Frames sealed and opened, for a log line: never their content. */
  sent: number
  received: number

  constructor(o: RelayChannelOptions) {
    this.o = o
    this.eph = relayEphemeral(o.fixed?.eph)
    this.st = 'idle'
    this.hs1 = null
    this.hs2 = null
    this.th = ''
    this.peerSign = null
    this.sendCipher = null
    this.recvCipher = null
    this.parts = []
    this.partChars = 0
    this.sent = 0
    this.received = 0
  }

  get state(): ChannelState {
    return this.st
  }

  /**
   * The peer's signing key this end checked the handshake against, pinned
   * from THIS device's chain when the handshake began — or null before then.
   * An end that later finds its chain no longer holds the peer by that key
   * (a revoke) ends the channel (`HubRemote.chainChanged`).
   */
  get peerSignKey(): string | null {
    return this.peerSign
  }

  /** Begin: a guest sends `hs1`; a host waits for it. */
  start(): void {
    if (this.st !== 'idle') return
    this.st = 'handshake'
    if (this.o.role === 'host') return
    this.peerSign = this.o.peerKey(this.o.peer)
    if (!this.peerSign) {
      this.fail('That machine is not in your verified device list any more.')
      return
    }
    this.hs1 = relayHello({ relay: this.o.relay, account: this.o.account, guest: this.o.me.id, host: this.o.peer }, this.eph, this.o.fixed?.nonce)
    this.o.io.send(JSON.stringify(this.hs1))
  }

  /** One frame from the relay socket. */
  receive(data: Uint8Array | string, binary: boolean): void {
    if (this.st === 'closed') return
    if (this.st === 'idle') this.start()
    if (this.st === 'handshake') {
      if (binary || typeof data !== 'string') return this.fail('the handshake was not finished')
      let v: unknown
      try {
        v = JSON.parse(data)
      } catch {
        return this.fail('a handshake frame was not JSON')
      }
      if (this.o.role === 'guest') this.onHs2(v)
      else if (!this.hs1) this.onHs1(v)
      else this.onHs3(v)
      return
    }
    if (!binary || typeof data === 'string') return this.fail('a text frame arrived after the handshake')
    const plain = this.recvCipher?.open(data) ?? null
    if (!plain) return this.fail('a frame did not open: dropped, repeated, reordered or changed on the way')
    this.received++
    const text = fromUtf8(plain)
    const frame = text === null ? null : parseRelayInner(text)
    if (!frame) return this.fail('a frame was not a relay frame')
    if (frame.t !== 'part') {
      if (this.parts.length) return this.fail('a frame arrived in the middle of another')
      this.o.events.onFrame(frame)
      return
    }
    this.partChars += frame.data.length
    if (this.partChars > RELAY_MAX_MESSAGE_CHARS) return this.fail('a frame grew past the largest one a relay carries')
    this.parts.push(frame.data)
    if (frame.more) return
    const whole = this.parts.join('')
    this.parts = []
    this.partChars = 0
    const joined = parseRelayInner(whole)
    if (!joined || joined.t === 'part') return this.fail('a joined frame was not a relay frame')
    this.o.events.onFrame(joined)
  }

  /** Seal and send one inner frame (cut into `part`s when large). False when the channel is not open. */
  send(frame: RelayInnerFrame): boolean {
    if (this.st !== 'open' || !this.sendCipher) return false
    try {
      for (const text of relayFrameParts(JSON.stringify(frame))) {
        const sealed = this.sendCipher.seal(utf8(text))
        if (sealed.length > RELAY_MAX_FRAME_BYTES) throw new Error('a relay frame part came out larger than the hub carries')
        this.o.io.send(sealed)
        this.sent++
      }
      return true
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /** Close from this end (or because the socket under it closed). */
  close(reason: string, code = 1000): void {
    if (this.st === 'closed') return
    this.st = 'closed'
    this.sendCipher = null
    this.recvCipher = null
    this.parts = []
    try {
      this.o.io.close(code, reason.slice(0, 120))
    } catch {
      /* the socket is already gone */
    }
    this.o.events.onClose(reason)
  }

  private fail(reason: string): void {
    // 1008: policy — the other end, or the relay, broke the protocol.
    this.close(reason, 1008)
  }

  /* ------------------------------------------------------------ guest */

  private onHs2(v: unknown): void {
    if (!this.hs1 || !this.peerSign) return this.fail('the handshake was not started')
    const fin = relayFinish(this.hs1, v as RelayHs2, this.peerSign, this.o.me.signPriv)
    if (!fin.ok) return this.fail(fin.reason)
    const keys = relayKeys(this.eph, (v as RelayHs2).eph, fin.th)
    if (!keys) return this.fail('the host’s key did not agree')
    this.o.io.send(JSON.stringify(fin.hs3))
    this.sendCipher = new RelayCipher(keys.g2h, 'g2h', this.o.relay)
    this.recvCipher = new RelayCipher(keys.h2g, 'h2g', this.o.relay)
    this.st = 'open'
    this.o.events.onOpen()
  }

  /* ------------------------------------------------------------- host */

  private onHs1(v: unknown): void {
    const problem = hs1Problem(v, { relay: this.o.relay, account: this.o.account, host: this.o.me.id })
    if (problem) return this.fail(problem)
    const hs1 = v as RelayHs1
    if (hs1.guest !== this.o.peer) return this.fail('the guest is not the device the hub named')
    this.peerSign = this.o.peerKey(hs1.guest)
    if (!this.peerSign) return this.fail('that device is not in this computer’s verified device list')
    const { hs2, th } = relayAnswer(hs1, this.eph, this.o.me.signPriv, this.o.fixed?.nonce)
    this.hs1 = hs1
    this.hs2 = hs2
    this.th = th
    this.o.io.send(JSON.stringify(hs2))
  }

  private onHs3(v: unknown): void {
    if (!this.hs1 || !this.hs2 || !this.peerSign) return this.fail('the handshake was not started')
    if (!relayAccept(this.th, this.hs2, v as RelayHs3, this.peerSign)) return this.fail('the guest did not sign this handshake with its own key')
    const keys = relayKeys(this.eph, this.hs1.eph, this.th)
    if (!keys) return this.fail('the guest’s key did not agree')
    this.sendCipher = new RelayCipher(keys.h2g, 'h2g', this.o.relay)
    this.recvCipher = new RelayCipher(keys.g2h, 'g2h', this.o.relay)
    this.st = 'open'
    this.o.events.onOpen()
  }
}
