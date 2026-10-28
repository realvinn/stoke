import { useEffect, useRef, useState } from 'react'
import type { SshHost, VoiceSettings } from '@shared/types'
import { meterStream, openMicrophone } from '@shared/voice'
import { microphoneError } from '@shared/voiceRoute'
import { MIC_FRAME_SAMPLES, MIC_SAMPLE_RATE, micKeyOf, micStripText, type MicPane } from '@shared/micTunnel'
// `no-inline`: under 4 KB Vite inlines an asset as a `data:` URL, and the renderer's CSP
// (`script-src 'self'`) refuses a data: worklet module, so the built app fell back to the
// ScriptProcessor (measured 2026-10-28). As a file it loads from 'self'.
import workletUrl from '../lib/micWorklet.js?url&no-inline'

/*
 * The lent microphone in a terminal pane (shared/micTunnel.ts has the why).
 *
 * In an SSH tab whose host lends the microphone this hook does three things,
 * and none of them takes a key from the terminal:
 *
 *  - It REPORTS to main what the gate needs: each key in the tab (a Space's
 *    down, repeats and up; any other key as "other"; never a bare modifier,
 *    never the key itself), and the pane's state — in front, holding the
 *    keyboard in a focused window, Stoke's own dictation on or off.
 *  - It opens the microphone only when main says a connection was ADMITTED
 *    (`micTunnel.onOpen`), at 16 kHz through an AudioWorklet that posts 20 ms
 *    frames of S16LE, and closes it the moment main says the stream ended.
 *  - It draws "Mic → <host>" with a level line and Stop while streaming, in
 *    the dictation strip's place and look (`.voice-strip`: the find bar keeps
 *    under it, CORNER_FLOATS). A strip, not a toast: it is live, and it has
 *    the one button that matters (gotcha 154).
 */

/** How long a "could not open the microphone" line stays. */
const NOTICE_MS = 9000

interface Capture {
  streamId: string
  stop: (() => void) | null
}

/** Open the microphone and pump 20 ms frames to main until the returned stop. */
async function startCapture(
  voice: VoiceSettings,
  onFrame: (pcm: ArrayBuffer) => void,
  onLevel: (level: number) => void
): Promise<() => void> {
  const { stream } = await openMicrophone(voice.micDeviceId ? { id: voice.micDeviceId, label: voice.micLabel } : null)
  const stopTracks = (): void => stream.getTracks().forEach((t) => t.stop())
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
  } catch {
    // The worklet resamples whatever rate the device runs at.
    ctx = new AudioContext()
  }
  try {
    void ctx.resume().catch(() => {})
    const source = ctx.createMediaStreamSource(stream)
    let detach: () => void
    try {
      await ctx.audioWorklet.addModule(workletUrl)
      const node = new AudioWorkletNode(ctx, 'stoke-mic-frames', { numberOfInputs: 1, numberOfOutputs: 0 })
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onFrame(e.data)
      source.connect(node)
      detach = () => {
        node.port.onmessage = null
        source.disconnect()
      }
    } catch {
      /*
       * No AudioWorklet (or its module refused): a ScriptProcessorNode on the
       * page's thread, the same conversion. Deprecated but still in Chromium;
       * it only runs while connected to the destination, through a gain of 0
       * so nothing is ever played back.
       */
      const proc = ctx.createScriptProcessor(1024, 1, 1)
      const mute = ctx.createGain()
      mute.gain.value = 0
      const step = ctx.sampleRate / MIC_SAMPLE_RATE
      let pos = 0
      let acc = 0
      let count = 0
      let frame = new DataView(new ArrayBuffer(MIC_FRAME_SAMPLES * 2))
      let n = 0
      const push = (v: number): void => {
        const c = Math.max(-1, Math.min(1, v))
        frame.setInt16(n * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true)
        if (++n === MIC_FRAME_SAMPLES) {
          onFrame(frame.buffer as ArrayBuffer)
          frame = new DataView(new ArrayBuffer(MIC_FRAME_SAMPLES * 2))
          n = 0
        }
      }
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0)
        for (let i = 0; i < ch.length; i++) {
          if (step <= 1) {
            push(ch[i])
            continue
          }
          acc += ch[i]
          count++
          pos += 1
          if (pos >= step) {
            pos -= step
            push(acc / count)
            acc = 0
            count = 0
          }
        }
      }
      source.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      detach = () => {
        proc.onaudioprocess = null
        source.disconnect()
        proc.disconnect()
        mute.disconnect()
      }
    }
    const stopMeter = meterStream(stream, onLevel)
    return () => {
      detach()
      stopMeter()
      void ctx.close().catch(() => {})
      stopTracks()
    }
  } catch (err) {
    void ctx.close().catch(() => {})
    stopTracks()
    throw err
  }
}

export function useMicTunnel({
  ptyId,
  lending,
  host,
  hostRef,
  active,
  dictating,
  voice
}: {
  ptyId: string
  /** This tab lends the microphone: an SSH tab, running, whose host has it on. */
  lending: boolean
  host: SshHost | null
  hostRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  dictating: boolean
  voice: VoiceSettings
}): { streaming: boolean; strip: React.JSX.Element | null } {
  const [live, setLive] = useState<{ streamId: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const captureRef = useRef<Capture | null>(null)
  const levelRef = useRef<HTMLSpanElement>(null)
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const label = host ? host.label.trim() || host.alias.trim() : 'this machine'

  /*
   * The pane's state, sent whenever it may have moved. Read from the DOM each
   * time rather than tracked: whether the terminal holds the keyboard is
   * `document.activeElement` inside the host in a focused document.
   */
  const dictatingRef = useRef(dictating)
  dictatingRef.current = dictating
  const activeRef = useRef(active)
  activeRef.current = active
  /*
   * What main was told last, shared by BOTH effects below. With a copy per
   * effect, the props effect could send "focused" after this one had sent
   * "not focused", and this one would then skip its next "not focused" as
   * unchanged: main left believing the terminal held the keyboard.
   */
  const sentPaneRef = useRef('')
  const sendPane = (pane: MicPane): void => {
    sentPaneRef.current = `${pane.front}${pane.focused}${pane.dictating}`
    window.stoke.micTunnel.pane(ptyId, pane)
  }
  useEffect(() => {
    const el = hostRef.current
    if (!lending || !el) return
    sentPaneRef.current = ''
    const report = (): void => {
      const pane: MicPane = {
        front: activeRef.current,
        focused: document.hasFocus() && el.contains(document.activeElement),
        dictating: dictatingRef.current
      }
      if (`${pane.front}${pane.focused}${pane.dictating}` === sentPaneRef.current) return
      sendPane(pane)
    }
    report()
    // Keys: observed in the capture phase, never taken.
    const onKey = (e: KeyboardEvent): void => {
      const kind = micKeyOf(e)
      if (kind) window.stoke.micTunnel.key(ptyId, kind)
    }
    const onFocus = (): void => {
      // focusout lands before the new element has focus; look once it has.
      queueMicrotask(report)
    }
    el.addEventListener('keydown', onKey, true)
    el.addEventListener('keyup', onKey, true)
    el.addEventListener('focusin', onFocus)
    el.addEventListener('focusout', onFocus)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const poll = window.setInterval(report, 500)
    return () => {
      el.removeEventListener('keydown', onKey, true)
      el.removeEventListener('keyup', onKey, true)
      el.removeEventListener('focusin', onFocus)
      el.removeEventListener('focusout', onFocus)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(poll)
      sendPane({ front: false, focused: false, dictating: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lending, ptyId, hostRef])

  // The front/dictating inputs come from props; send them as they move.
  useEffect(() => {
    if (!lending) return
    const el = hostRef.current
    sendPane({
      front: active,
      focused: !!el && document.hasFocus() && el.contains(document.activeElement),
      dictating
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lending, ptyId, active, dictating, hostRef])

  const stopCapture = (): void => {
    const c = captureRef.current
    captureRef.current = null
    c?.stop?.()
    if (levelRef.current) levelRef.current.style.transform = 'scaleX(0)'
  }

  // Main's word: open for an admitted connection, close when it ends.
  useEffect(() => {
    if (!lending) return
    const offOpen = window.stoke.micTunnel.onOpen((e) => {
      if (e.ptyId !== ptyId) return
      stopCapture()
      // A fresh claim per stream (gotcha 20's 2026-09-30 note): a close that
      // lands while the microphone is still opening finds a different object.
      const mine: Capture = { streamId: e.streamId, stop: null }
      captureRef.current = mine
      setLive({ streamId: e.streamId })
      setNotice(null)
      void startCapture(
        voiceRef.current,
        (pcm) => {
          if (captureRef.current === mine) window.stoke.micTunnel.frame(e.streamId, pcm)
        },
        (level) => {
          const fill = levelRef.current
          if (fill) fill.style.transform = `scaleX(${level.toFixed(3)})`
        }
      ).then(
        (stop) => {
          if (captureRef.current === mine) mine.stop = stop
          else stop()
        },
        (err: unknown) => {
          if (captureRef.current !== mine) return
          captureRef.current = null
          setLive(null)
          setNotice(`The microphone could not be opened for ${label}: ${microphoneError(err, window.stoke.platform)}`)
          window.stoke.micTunnel.stop(e.streamId, 'failed')
        }
      )
    })
    const offClose = window.stoke.micTunnel.onClose((e) => {
      if (e.ptyId !== ptyId) return
      if (captureRef.current?.streamId === e.streamId) stopCapture()
      setLive((l) => (l?.streamId === e.streamId ? null : l))
    })
    return () => {
      offOpen()
      offClose()
      stopCapture()
      setLive(null)
    }
    // `label` only words a failure; the subscription is per pty.
  }, [lending, ptyId])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  const stop = (): void => {
    const l = live
    if (!l) return
    stopCapture()
    setLive(null)
    window.stoke.micTunnel.stop(l.streamId, 'stop')
  }

  const strip =
    live || notice ? (
      <div
        className="voice-strip"
        role="status"
        data-mic-tunnel="true"
        data-tone={notice && !live ? 'error' : undefined}
        // Plain keys on Stop stay here: App types an unclaimed key on a focused
        // button through to the terminal (`typeThroughKey`), as Dictation's strip says.
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          e.stopPropagation()
        }}
      >
        <div className="voice-row">
          <span className="voice-dot" data-state={live ? 'recording' : 'error'} />
          <span className="voice-text">{live ? micStripText(label) : notice}</span>
          {live && (
            <button className="btn" data-size="sm" onClick={stop} aria-label={`Stop lending the microphone to ${label}`}>
              Stop
            </button>
          )}
        </div>
        {live && (
          <span className="voice-level" aria-hidden="true" data-live="true">
            <span ref={levelRef} className="voice-level-fill" />
          </span>
        )}
      </div>
    ) : null

  return { streaming: !!live, strip }
}
