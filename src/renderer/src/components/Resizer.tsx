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
        if (!dragging) return
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
