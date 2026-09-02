import { useRef, useState } from 'react'
import { clamp } from '../lib/format'

interface Props {
  value: number
  min: number
  max: number
  /** True when the panel grows as the pointer moves left (right-hand panels). */
  invert?: boolean
  label: string
  onChange: (next: number) => void
  onCommit: (next: number) => void
}

export function Resizer({
  value,
  min,
  max,
  invert = false,
  label,
  onChange,
  onCommit
}: Props): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, value: 0 })
  const latest = useRef(value)

  return (
    <div
      className="resizer"
      data-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, value }
        latest.current = value
        setDragging(true)
      }}
      onPointerMove={(e) => {
        // `dragging` alone was the whole guard, and it is only ever cleared by
        // pointerup. A drag the browser takes away — see onPointerCancel —
        // therefore left this resizing on plain hover, with nothing held. The
        // buttons bitmask is the authoritative "is the primary button down",
        // and it costs nothing to ask.
        if (!dragging) return
        if ((e.buttons & 1) === 0) {
          setDragging(false)
          onCommit(latest.current)
          return
        }
        const delta = e.clientX - start.current.x
        const next = clamp(start.current.value + (invert ? -delta : delta), min, max)
        latest.current = next
        onChange(next)
      }}
      onPointerUp={(e) => {
        if (!dragging) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDragging(false)
        onCommit(latest.current)
      }}
      /*
       * A drag the browser ends on its own: the OS taking the pointer, a
       * touch cancelled by a scroll gesture, the window losing capture. No
       * pointerup follows, so without this `dragging` stayed true forever and
       * the panel resized on every subsequent mouse MOVE across the handle —
       * a resizer that has to be clicked to switch it back off.
       *
       * Commits rather than reverting: the user did drag it somewhere, and
       * throwing that away because the gesture ended unusually would be the
       * more surprising of the two.
       */
      onPointerCancel={(e) => {
        if (!dragging) return
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
        setDragging(false)
        onCommit(latest.current)
      }}
      // Keyboard resizing keeps the panel reachable without a pointer.
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          const next = clamp(value + (invert ? step : -step), min, max)
          onChange(next)
          onCommit(next)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          const next = clamp(value + (invert ? -step : step), min, max)
          onChange(next)
          onCommit(next)
        }
      }}
    />
  )
}
