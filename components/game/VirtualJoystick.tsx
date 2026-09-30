'use client'

import { useRef, useState } from 'react'

type Props = {
  onChange: (dx: number, dy: number) => void
  size?: number
}

/** Dokunmatik/pointer için sanal joystick. -1..1 aralığında vektör üretir. */
export function VirtualJoystick({ onChange, size = 132 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const active = useRef(false)

  const update = (clientX: number, clientY: number) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const radius = rect.width / 2
    let dx = (clientX - cx) / radius
    let dy = (clientY - cy) / radius
    const length = Math.hypot(dx, dy)
    if (length > 1) {
      dx /= length
      dy /= length
    }
    setKnob({ x: dx, y: dy })
    onChange(dx, dy)
  }

  const end = () => {
    active.current = false
    setKnob({ x: 0, y: 0 })
    onChange(0, 0)
  }

  return (
    <div
      ref={ref}
      className="joystick"
      style={{ width: size, height: size }}
      onPointerDown={(event) => {
        active.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        update(event.clientX, event.clientY)
      }}
      onPointerMove={(event) => {
        if (active.current) update(event.clientX, event.clientY)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={() => {
        if (active.current) end()
      }}
    >
      <span
        className="joystick-knob"
        style={{ transform: `translate(${knob.x * 40}px, ${knob.y * 40}px)` }}
      />
    </div>
  )
}
